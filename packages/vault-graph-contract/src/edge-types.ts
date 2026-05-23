/**
 * Canonical edge-type names shared across vault-mcp and vault-mcp-power Workers.
 *
 * This is the single source of truth for edge-type name constants.
 * Neither Worker should define its own copy of this enum.
 *
 * Note: vault-mcp edges are path-based; vault-mcp-power edges are node-id-based.
 * The types here describe the semantic *names* only — not the schema shape.
 * Historical D1 migrations are not updated to consume this file.
 */

export const EDGE_TYPE = {
  WIKILINK: "wikilink",
  TAG: "tag",
  RELATED: "related",
  FOLDER: "folder",
  TEMPORAL: "temporal",
  TAG_COOCCURRENCE: "tag_cooccurrence",
  SPOKE_IN: "spoke_in",
  DISCUSSES: "discusses",
  PREDICTS: "predicts",
  CLAIMS: "claims",
  PART_OF: "part_of",
  HAS_PART: "has_part",
  REFERENCES: "references",
  DERIVED_FROM: "derived_from",
  VERSION_OF: "version_of",
  REPLACES: "replaces",
  REPLACED_BY: "replaced_by",
  REQUIRES: "requires",
  REQUIRED_BY: "required_by",
  INSTANCE_OF: "instance_of",
  BROADER: "broader",
  NARROWER: "narrower",
  SUPPORTS: "supports",
  CONTRADICTS: "contradicts",
  EVOLVED_INTO: "evolved_into",
  INSPIRED_BY: "inspired_by",
  DEPENDS_ON: "depends_on",
  OVERRIDES: "overrides",
  LEARNED_FROM: "learned_from",
  SCOPED_BY: "scoped_by",
  REJECTED: "rejected",
  BELONGS_TO: "belongs_to",
  FRONTMATTER: "frontmatter",
  EXTRACTED_FROM: "extracted_from",
} as const;

export type EdgeTypeName = (typeof EDGE_TYPE)[keyof typeof EDGE_TYPE];

/**
 * Edge types used in vault-mcp (path-based edges, 30-type schema).
 * Does not include atlas-only types (frontmatter, extracted_from).
 */
export const VAULT_MCP_EDGE_TYPES = [
  EDGE_TYPE.WIKILINK,
  EDGE_TYPE.TAG,
  EDGE_TYPE.RELATED,
  EDGE_TYPE.FOLDER,
  EDGE_TYPE.TEMPORAL,
  EDGE_TYPE.TAG_COOCCURRENCE,
  EDGE_TYPE.SPOKE_IN,
  EDGE_TYPE.DISCUSSES,
  EDGE_TYPE.PREDICTS,
  EDGE_TYPE.CLAIMS,
  EDGE_TYPE.PART_OF,
  EDGE_TYPE.HAS_PART,
  EDGE_TYPE.REFERENCES,
  EDGE_TYPE.DERIVED_FROM,
  EDGE_TYPE.VERSION_OF,
  EDGE_TYPE.REPLACES,
  EDGE_TYPE.REPLACED_BY,
  EDGE_TYPE.REQUIRES,
  EDGE_TYPE.REQUIRED_BY,
  EDGE_TYPE.INSTANCE_OF,
  EDGE_TYPE.BROADER,
  EDGE_TYPE.NARROWER,
  EDGE_TYPE.SUPPORTS,
  EDGE_TYPE.CONTRADICTS,
  EDGE_TYPE.EVOLVED_INTO,
  EDGE_TYPE.INSPIRED_BY,
  EDGE_TYPE.DEPENDS_ON,
  EDGE_TYPE.OVERRIDES,
  EDGE_TYPE.LEARNED_FROM,
  EDGE_TYPE.SCOPED_BY,
  EDGE_TYPE.REJECTED,
  EDGE_TYPE.BELONGS_TO,
] as const;

export type VaultMcpEdgeType = (typeof VAULT_MCP_EDGE_TYPES)[number];

/**
 * Edge types used in vault-mcp-power (node-id-based edges).
 * Mirrors the CHECK constraint in migrations/0001_initial.sql.
 * Do not rewrite that migration to consume this — keep migrations immutable.
 */
export const ATLAS_EDGE_TYPES = [
  EDGE_TYPE.WIKILINK,
  EDGE_TYPE.TAG,
  EDGE_TYPE.FOLDER,
  EDGE_TYPE.TEMPORAL,
  EDGE_TYPE.FRONTMATTER,
  EDGE_TYPE.EXTRACTED_FROM,
] as const;

export type AtlasEdgeType = (typeof ATLAS_EDGE_TYPES)[number];
