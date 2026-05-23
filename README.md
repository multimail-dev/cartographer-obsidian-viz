# Cartographer

Turn your Obsidian vault into an interactive knowledge graph. Parses every markdown note, extracts structural relationships, runs graph algorithms, and renders a force-directed visualization you can explore in your browser.

No account required. No cloud. Just your vault.

![Full graph view — 48 notes, 5 communities detected by Louvain, ForceAtlas3 layout](https://github.com/multimail-dev/cartographer-pub/releases/download/v0.1.0/cartographer-hero.png)

```bash
bun install && bun run build
bun run local ~/path/to/vault
# → http://localhost:4321
```

## What it does

Cartographer reads your `.md` files and builds a typed knowledge graph from the structure already in your notes:

| Edge type | Source |
|-----------|--------|
| **Wikilinks** | `[[note]]` references between notes |
| **Tags** | Shared `#tags` (IDF-weighted — rare tags score higher) |
| **Folder co-membership** | Notes in the same directory |
| **Temporal adjacency** | Notes created within ±7 days of each other |

Then it runs four graph algorithms on the result:

| Algorithm | What it tells you |
|-----------|-------------------|
| **PageRank** | Which notes are most structurally important |
| **Louvain community detection** | How your notes naturally cluster into topics |
| **Connected components** | Which groups of notes are isolated from each other |
| **Clustering coefficient** | How tightly interconnected each note's neighbors are |

All computation happens at startup. A 3,000-note vault parses and enriches in ~1.5 seconds.

## Atlas UI

The visualization is built on [Sigma.js](https://www.sigmajs.org/) with a custom **ForceAtlas3** layout engine — a Float32Array-based reimplementation of ForceAtlas2 that lays out 8,500 nodes in under 2 seconds.

![Seeded view — "Knowledge Graph" note with its structural neighborhood, PageRank rank, community pressure, and inspector panel](https://github.com/multimail-dev/cartographer-pub/releases/download/v0.1.0/cartographer-seeded.png)

**Navigation**
- **⌘K** to search across all notes (title, path, tags, frontmatter)
- Click a node to open the **inspector panel** — rendered note content, PageRank rank, degree, community ID, bridge score
- Seed a note to expand its **structural neighborhood** (1–3 hop BFS)

**Analysis**
- **Community pressure** sidebar shows how the visible neighborhood clusters
- **Data Lab** table view with sortable columns and CSV export
- **Edge legend** with type counts and toggle visibility per type

**Layout options**
- ForceAtlas 3 (default — fast convergence, good cluster separation)
- Fruchterman-Reingold, Circular, Concentric, Grid
- Toggle color encoding: note type vs. Louvain community
- Toggle size encoding: uniform vs. PageRank vs. degree

## ForceAtlas3

The layout engine deserves its own mention. ForceAtlas2 is the standard for graph visualization, but the reference JavaScript implementation takes 18+ seconds on a large vault. Our ForceAtlas3 port uses flat `Float32Array` matrices (10 floats/node, 3 floats/edge) and runs the same layout in under 2 seconds — a 9× speedup with equivalent visual quality.

The implementation includes Barnes-Hut optimization for O(n log n) repulsion, adaptive convergence per node, and optional LinLog mode. It runs in a Web Worker so the UI stays responsive during layout.

```
ForceAtlas2 (graphology):  18.2s  (8,500 nodes)
ForceAtlas3 (this repo):    1.9s  (8,500 nodes, same quality)
```

Source: [`apps/atlas-ui/src/core/forceatlas3.ts`](apps/atlas-ui/src/core/forceatlas3.ts) — 590 lines, zero dependencies.

## Project structure

```
apps/atlas-ui/
  serve.ts                   ← Local server (this is what `bun run local` runs)
  src/core/                  ← Parser, graph builder, PageRank, Louvain, FA3
  src/frontend/              ← Browser app (Sigma.js + controls)
workers/vault-mcp/           ← Cloudflare Worker (optional cloud deployment)
packages/
  vault-graph-contract/      ← Shared edge types + API DTOs
  sync-engine/               ← R2 ↔ local vault sync (for cloud mode)
```

<details>
<summary><strong>Cloud deployment (optional)</strong></summary>

For hosted access with MCP tools and Bearer API, deploy to Cloudflare Workers.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Setup

```bash
wrangler d1 create vault-graph
wrangler r2 create obsidian-vault
wrangler kv namespace create OAUTH_KV

# Edit workers/vault-mcp/wrangler.toml — replace YOUR_* placeholders

wrangler secret put SHARED_SECRET -c workers/vault-mcp/wrangler.toml
wrangler secret put COOKIE_ENCRYPTION_KEY -c workers/vault-mcp/wrangler.toml

bun run build
wrangler deploy -c workers/vault-mcp/wrangler.toml
wrangler d1 migrations apply vault-graph --remote -c workers/vault-mcp/wrangler.toml
```

### Architecture (cloud mode)

```
              Atlas UI              MCP clients           HTTP API
                 |                      |                    |
                 v                      v                    v
          +-----------+          +------------+       +----------+
          | UI assets |          | OAuth flow |       | Bearer   |
          | (embedded)|          | (MCP SDK)  |       | auth     |
          +-----------+          +------------+       +----------+
                 \                     |                   /
                  \                    v                  /
                   +-------> Cloudflare Worker <---------+
                             (Durable Object)
                                   |
                +------------------+------------------+
                v                  v                  v
             D1 (SQL)          R2 (objects)        KV (tokens)
          vault_nodes        *.md notes          OAuth state
          vault_edges
          vault_ops
          vault_fts
```

### Authentication

| Mode | Path | Use case |
|------|------|----------|
| OAuth (MCP SDK) | `/mcp` | Claude Desktop, Cursor, MCP clients |
| Bearer token | `/api/*` | Headless pipelines, cron jobs, scripts |
| CF Access (optional) | `SVC_HOSTNAME/mcp` | Service-token headless MCP |

### MCP tools (cloud mode only)

12 tools registered for AI agent use:

| Tool | Description |
|------|-------------|
| `build_graph` | Full graph rebuild (phased: extract then finalize) |
| `sync_graph` | Incremental re-index of recently modified notes |
| `read_note` | Read a note's markdown content |
| `write_note` | Create or update a note with frontmatter validation |
| `delete_note` | Remove a note from storage and graph |
| `search_notes` | Full-text search with wiki cross-references |
| `find_related` | BFS graph traversal with hub dampening |
| `topic_dossier` | Wiki-first structured retrieval for topics |
| `vault_health` | Graph diagnostics (hubs, orphans, clusters, stats) |
| `ingest_triples` | Direct subject-relation-object edge writes |
| `list_notes` | Paginated note listing with folder filter |
| `list_folders` | Paginated folder listing |

### API endpoints (cloud mode only)

All `/api/*` endpoints require `Authorization: Bearer <SHARED_SECRET>`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/build-graph` | POST | Full graph rebuild from R2 vault |
| `/api/sync-graph` | POST | Incremental sync (last 20 modified notes) |
| `/api/fast-score` | POST | Bridge detection, centrality anomalies |
| `/api/graph-qa` | POST | Graph diagnostics and health checks |
| `/api/ingest-triples` | POST | Direct subject-relation-object edge writes |
| `/api/graph/nodes` | GET | Paginated node list with filters |
| `/api/graph/edges` | GET | Paginated edge list with type filter |
| `/api/search` | GET | Full-text search across notes |
| `/api/note` | GET | Read a single note by path |

</details>

## Development

```bash
bun install
bun run build
bash workers/vault-mcp/scripts/test.sh    # 256 tests
```

## License

MIT — see [LICENSE](LICENSE).
