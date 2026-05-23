// catalog-origin: ghst-core/typescript/src/auth/bearer.ts
// catalog-version: 2026-04-17
// catalog-sha: 77ccae60

// SHA-256 both inputs to fixed-length digests, then compare in constant time over the
// equal-length buffers. This avoids crypto.subtle.timingSafeEqual (Workers-only extension,
// missing on Node WebCrypto) and node:crypto (would force nodejs_compat on Workers).
// Both runtimes expose globalThis.crypto.subtle.digest, so a single code path serves both.
//
// Outbound `bearerHeader` helper is intentionally Py-only (see plan §Module shapes). TS
// consumers construct the header inline or via `http/client` when that primitive lands.
const BEARER_PREFIX = "Bearer ";
const ENC = new TextEncoder();

export async function verifyBearer(
  authHeader: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!authHeader || !secret) return false;
  if (!authHeader.startsWith(BEARER_PREFIX)) return false;
  const candidate = authHeader.slice(BEARER_PREFIX.length);
  if (candidate.length === 0 || candidate.includes(" ")) return false;

  const [candBuf, secrBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", ENC.encode(candidate)),
    crypto.subtle.digest("SHA-256", ENC.encode(secret)),
  ]);
  const candHash = new Uint8Array(candBuf);
  const secrHash = new Uint8Array(secrBuf);

  let acc = 0;
  for (let i = 0; i < candHash.length; i++) acc |= candHash[i]! ^ secrHash[i]!;
  return acc === 0;
}
