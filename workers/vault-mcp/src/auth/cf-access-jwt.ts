// catalog-origin: ghst-core/typescript/src/auth/cf-access.ts
// catalog-version: 2026-04-17
// catalog-sha: a9062a8b

// CF Access JWT verify primitive. Header-only. Never accepts header presence as auth (R6).
// Signature verified against the team JWKS via jose's createRemoteJWKSet; all jose errors are
// rethrown as CfAccessError with discriminated `kind` so consumers don't import jose classes (R19).
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";

export type AccessClaims = Readonly<{
  sub: string;
  email?: string;
  aud: string | string[];
  iss: string;
  iat: number;
  exp: number;
  [claim: string]: unknown;
}>;

export type JWKSCacheInput = Readonly<{
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}>;

export type VerifyCfAccessJwtOptions = Readonly<{
  teamDomain: string;
  aud: string;
  jwksCache?: JWKSCacheInput;
  allowLocalDevBypass?: boolean;
}>;

export type CfAccessErrorKind =
  | "expired"
  | "invalid_signature"
  | "wrong_audience"
  | "no_matching_key"
  | "jwks_fetch_failed";

export class CfAccessError extends Error {
  readonly kind: CfAccessErrorKind;
  constructor(kind: CfAccessErrorKind, message: string) {
    super(message);
    this.name = "CfAccessError";
    this.kind = kind;
  }
}

type RemoteJwksOptions = NonNullable<Parameters<typeof createRemoteJWKSet>[1]>;
type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

const DEFAULT_REMOTE_JWKS_OPTIONS: RemoteJwksOptions = {
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
  timeoutDuration: 5_000,
};

const JWKS_CACHE_TTL_SECONDS = 600;

const jwksRegistry = new Map<string, RemoteJwks>();

function trimTrail(u: string): string {
  // Accept teamDomain stored with or without scheme. Callers sometimes set
  // CF_ACCESS_TEAM_DOMAIN as "<team>.cloudflareaccess.com" (bare host),
  // which makes `new URL()` throw when building the JWKS URL.
  const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme;
}

function jwksUrlFor(teamDomain: string): string {
  return `${trimTrail(teamDomain)}/cdn-cgi/access/certs`;
}

function issuerFor(teamDomain: string): string {
  return trimTrail(teamDomain);
}

function getOrCreateRemoteJwks(teamDomain: string): RemoteJwks {
  let entry = jwksRegistry.get(teamDomain);
  if (!entry) {
    let url: URL;
    try {
      url = new URL(jwksUrlFor(teamDomain));
    } catch (e) {
      throw new CfAccessError(
        "jwks_fetch_failed",
        `Invalid teamDomain (cannot build JWKS URL): ${(e as Error).message}`,
      );
    }
    entry = createRemoteJWKSet(url, DEFAULT_REMOTE_JWKS_OPTIONS);
    jwksRegistry.set(teamDomain, entry);
  }
  return entry;
}

/** @internal — test-only. Reset the module-scoped JWKS registry between tests. */
export function _resetJwksCacheForTests(): void {
  jwksRegistry.clear();
}

/** @internal — test-only. Inject a pre-configured createRemoteJWKSet (e.g. cooldownDuration: 0 for G8 rotation). */
export function _setJwksCacheEntryForTests(teamDomain: string, entry: RemoteJwks): void {
  jwksRegistry.set(teamDomain, entry);
}

function synthLocalDevClaims(aud: string, teamDomain: string): AccessClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "local-dev",
    aud,
    iss: issuerFor(teamDomain),
    iat: now,
    exp: now + 3600,
  };
}

type ResolvedVerifier = { getKey: RemoteJwks; fromKvCache: boolean };

async function fetchAndCacheJwks(opts: VerifyCfAccessJwtOptions): Promise<RemoteJwks> {
  let resp: Response;
  try {
    resp = await fetch(jwksUrlFor(opts.teamDomain));
  } catch (e) {
    throw new CfAccessError("jwks_fetch_failed", `JWKS fetch failed: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new CfAccessError("jwks_fetch_failed", `JWKS fetch HTTP ${resp.status}`);
  }
  let text: string;
  let jwks: JSONWebKeySet;
  try {
    text = await resp.text();
    jwks = JSON.parse(text) as JSONWebKeySet;
  } catch (e) {
    throw new CfAccessError("jwks_fetch_failed", `JWKS parse failed: ${(e as Error).message}`);
  }
  if (opts.jwksCache) {
    try {
      await opts.jwksCache.put(opts.teamDomain, text, {
        expirationTtl: JWKS_CACHE_TTL_SECONDS,
      });
    } catch (e) {
      throw new CfAccessError("jwks_fetch_failed", `JWKS cache write failed: ${(e as Error).message}`);
    }
  }
  try {
    return createLocalJWKSet(jwks) as RemoteJwks;
  } catch (e) {
    // createLocalJWKSet throws JWKSInvalid on structurally invalid JWKS
    // (e.g. "keys" not an array). Map to jwks_fetch_failed to keep the
    // five-kind contract.
    throw new CfAccessError("jwks_fetch_failed", `JWKS structure invalid: ${(e as Error).message}`);
  }
}

async function resolveJwksVerifier(opts: VerifyCfAccessJwtOptions): Promise<ResolvedVerifier> {
  if (!opts.jwksCache) {
    return { getKey: getOrCreateRemoteJwks(opts.teamDomain), fromKvCache: false };
  }
  let cached: string | null;
  try {
    cached = await opts.jwksCache.get(opts.teamDomain);
  } catch (e) {
    throw new CfAccessError("jwks_fetch_failed", `JWKS cache read failed: ${(e as Error).message}`);
  }
  if (cached) {
    try {
      const jwks = JSON.parse(cached) as JSONWebKeySet;
      return { getKey: createLocalJWKSet(jwks) as RemoteJwks, fromKvCache: true };
    } catch {
      // Corrupted cache entry — fall through and refetch.
    }
  }
  return { getKey: await fetchAndCacheJwks(opts), fromKvCache: false };
}

/**
 * Verify a CF Access JWT against the team JWKS. Returns decoded claims on success; throws
 * CfAccessError on failure. Never accepts header presence as auth.
 */
export async function verifyCfAccessJwt(
  jwt: string,
  opts: VerifyCfAccessJwtOptions,
): Promise<AccessClaims> {
  if (opts.allowLocalDevBypass === true && jwt === "") {
    return synthLocalDevClaims(opts.aud, opts.teamDomain);
  }

  // Validate token shape before touching JWKS. Without this pre-flight, a
  // malformed JWT combined with a cache-miss JWKS fetch failure would be
  // misclassified as jwks_fetch_failed — the shape problem should always win.
  // `decodeProtectedHeader` validates the header segment; `decodeJwt` validates
  // the 3-segment structure and that the payload is base64url-encoded JSON.
  // Matches Py parity (pyjwt parses header+payload before key lookup).
  try {
    decodeProtectedHeader(jwt);
    decodeJwt(jwt);
  } catch (e) {
    if (e instanceof joseErrors.JOSEError) {
      throw new CfAccessError("invalid_signature", e.message);
    }
    throw new CfAccessError("invalid_signature", String(e));
  }

  const resolved = await resolveJwksVerifier(opts);

  try {
    const { payload } = await jwtVerify(jwt, resolved.getKey, {
      issuer: issuerFor(opts.teamDomain),
      audience: opts.aud,
    });
    return payload as unknown as AccessClaims;
  } catch (err) {
    if (err instanceof CfAccessError) throw err;
    // KV-cached JWKS may be stale across a CF key rotation. On no-matching-key
    // from a KV-sourced verifier, force-refetch once before surfacing the error.
    if (resolved.fromKvCache && err instanceof joseErrors.JWKSNoMatchingKey && opts.jwksCache) {
      const fresh = await fetchAndCacheJwks(opts);
      try {
        const { payload } = await jwtVerify(jwt, fresh, {
          issuer: issuerFor(opts.teamDomain),
          audience: opts.aud,
        });
        return payload as unknown as AccessClaims;
      } catch (retryErr) {
        if (retryErr instanceof CfAccessError) throw retryErr;
        throw mapJoseError(retryErr);
      }
    }
    throw mapJoseError(err);
  }
}

function mapJoseError(err: unknown): CfAccessError {
  if (err instanceof joseErrors.JWTExpired) {
    return new CfAccessError("expired", err.message);
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new CfAccessError("no_matching_key", err.message);
  }
  if (err instanceof joseErrors.JWKSTimeout) {
    return new CfAccessError("jwks_fetch_failed", err.message);
  }
  if (err instanceof joseErrors.JWKSInvalid || err instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return new CfAccessError("jwks_fetch_failed", err.message);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === "aud") return new CfAccessError("wrong_audience", err.message);
    return new CfAccessError("invalid_signature", err.message);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new CfAccessError("invalid_signature", err.message);
  }
  // Token-shape / algorithm failures are caller-token problems, not JWKS
  // transport problems. Map to invalid_signature (matches Py parity, where
  // pyjwt's DecodeError/InvalidTokenError path classifies these the same way).
  if (
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JOSEAlgNotAllowed ||
    err instanceof joseErrors.JOSENotSupported
  ) {
    return new CfAccessError("invalid_signature", err.message);
  }
  if (err instanceof joseErrors.JOSEError) {
    // Remaining generic JOSEError reaches here only after every specific
    // signature / token-shape / JWKS-structural class above has been
    // eliminated. What's left is overwhelmingly JWKS remote-fetch territory
    // (non-200, parse error, transport). Map to jwks_fetch_failed.
    return new CfAccessError("jwks_fetch_failed", err.message);
  }
  // Unknown non-jose error: fail closed on the fetch dimension.
  return new CfAccessError("jwks_fetch_failed", String(err));
}
