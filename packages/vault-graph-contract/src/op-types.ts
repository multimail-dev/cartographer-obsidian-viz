/**
 * Canonical op-log enums shared across vault-mcp and any replay/materializer
 * consumers. This mirrors the export shape used by edge-types.ts.
 */

export const VAULT_MCP_OP_TYPES = [
  "add_edge",
  "remove_edge",
  "upsert_node",
  "delete_node",
] as const;

export type VaultMcpOpType = (typeof VAULT_MCP_OP_TYPES)[number];

export const VAULT_MCP_OP_ORIGINS = [
  "extract",
  "ingest_triples",
  "finalize",
  "phantom_rewrite",
  "migration",
] as const;

export type VaultMcpOpOrigin = (typeof VAULT_MCP_OP_ORIGINS)[number];
