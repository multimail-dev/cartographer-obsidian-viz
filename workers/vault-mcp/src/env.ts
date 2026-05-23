export interface Env {
  VAULT: R2Bucket;
  VAULT_SNAPSHOTS: R2Bucket;
  DB: D1Database;
  SHARED_SECRET: string;
  VAULT_MCP: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  UI_HOSTNAME?: string;
  // CF Access for SaaS OIDC (web-OAuth flow)
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  /** Set to "1" to bypass FTS5 query sanitizer (rollback seam). */
  VAULT_FTS_RAW?: string;
  // CF Access self-hosted (headless flow on service-token hostname).
  // Branch in legacyDispatch validates Cf-Access-Jwt-Assertion + common_name
  // allowlist before dispatching to VAULT_MCP, bypassing OAuthProvider.
  SVC_HOSTNAME?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_SVC_AUD_TAG?: string;
  SERVICE_TOKEN_ALLOWLIST?: string;
}
