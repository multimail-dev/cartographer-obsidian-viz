# Vault MCP

Obsidian vault as an MCP server. R2-backed note storage, D1-backed knowledge graph, typed edges, PageRank centrality.

## Architecture

- Single file: `workers/vault-mcp/src/index.ts`. Cloudflare Worker + Durable Object for MCP sessions.
- D1 database: `vault-graph` -- vault_nodes, vault_edges, vault_ops, vault_centrality tables.
- R2 bucket: `obsidian-vault` -- all markdown notes.
- KV namespace: `OAUTH_KV` -- OAuth token storage.
- Edge types declared in `packages/vault-graph-contract/src/edge-types.ts`.

## Rules

### MCP Tool Descriptions

Every `registerTool` description must state: what it does, what it does NOT do, side effects, prerequisites, and when to use alternatives. Must include at least one "Does NOT" clause.

### Bearer Token Auth

All `/api/*` auth uses `crypto.subtle.timingSafeEqual()` via `verifyBearer()`. Centralized at top of the fetch handler -- individual endpoints should NOT re-check auth.

### wrangler.toml

`workers_dev = false` -- prevent default `.workers.dev` subdomain exposure. Custom domain only via routes.

### Secrets

Never commit `.dev.vars` or `.mcp.json`. Bearer tokens in `.dev.vars` (local) or wrangler secrets (prod).

### vault_ops is Audit Log + vault_edges is Materialized Cache

`vault_ops` is the append-only authoritative log of every edge/node mutation. `vault_edges` is the materialized cache that callers query -- reconstructed from `vault_ops` via origin-scoped reconciliation. There is no `DROP TABLE vault_edges` on any production code path.

### Edge Types

Typed edge types are declared in `packages/vault-graph-contract/src/edge-types.ts` (`VAULT_MCP_EDGE_TYPES`). The CHECK constraint in `buildGraph`'s extract phase is generated from that import, not hand-maintained inline. When adding a new type, add it to the contract package.

### Graph Scoring

Single-edge scoring only -- no path accumulation. Hub dampening: nodes with degree > 50 get discounted by `50/degree`. Dormant project dampening: 0.1x for `DAMPENED_FOLDERS` entries.

### R2 modified_at Is Not Authoring Time

`vault_nodes.modified_at` comes from R2 object metadata -- it reflects upload time, not when the note was written.

## Key Functions

- `extractEdgesFromNote()` -- creates typed edges from note content. The core of graph quality.
- `toolFindRelated()` -- BFS with hub dampening, cluster diversity, phantom filtering.
- `computeCentrality()` -- 10-iteration PageRank over D1.
- `runFastScore()` -- bridge detection, access-centrality divergence, tag anomalies, centrality shifts.
- `buildGraph()` -- phased: extract (200 notes/call) then finalize (folder/temporal/co-occurrence edges + degrees).

## Development

```bash
bun install
bun run build
bash workers/vault-mcp/scripts/test.sh
```

## Co-Authored-By

All commits: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
