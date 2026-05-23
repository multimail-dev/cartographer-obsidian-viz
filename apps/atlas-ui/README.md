# @vault-graph/atlas-ui

Cartographer workspace app for the Atlas graph explorer UI. Canonical source for the browser assets served by `workers/vault-mcp` at `your-atlas-domain.com`.

## Build flow

```
src/frontend/{app.ts, fa3-worker.ts, index.html, style.css}
         │
         │  bun run --filter @vault-graph/atlas-ui build
         │  (bun build → scripts/sync-artifacts.ts)
         ▼
workers/vault-mcp/public/{index.html, style.css,
                          dist/{app.js, app.js.txt,
                                fa3-worker.js, fa3-worker.js.txt}}
         │
         │  wrangler deploy (imports the above as text modules via
         │                   workers/vault-mcp/src/ui-handler.ts)
         ▼
  your-atlas-domain.com
```

Root scripts that chain into here:

- `bun run build` — full workspace build; includes `build:atlas-ui` before vault-mcp typecheck so text-module imports resolve.
- `bun run build:atlas-ui` — direct alias for this app's build.
- `bun run check:atlas-ui-artifacts` — rebuilds and fails if `workers/vault-mcp/public/{index.html, style.css, dist/*}` drift from source. CI runs this.

## What it does

- Parses any folder of markdown with YAML frontmatter and `[[wikilinks]]` into a typed graph
- Renders 10K+ nodes at 60fps via Sigma.js WebGL
- Progressive exploration: empty canvas, search to seed, expand neighborhoods, filter by edge/node type
- Four edge types out of the box: wikilink, tag, folder, temporal
- ForceAtlas3 layout runs in a Web Worker for interactive drag-and-settle
- Graph algorithms: Louvain community detection, PageRank, connected components, clustering coefficient
- Community coloring and PageRank sizing modes
- Timeline scrubber to filter nodes by created date range
- Graph metrics panel: nodes, edges, communities, components, avg degree, density
- Detail panel with raw note preview and Obsidian deep link
- Clear button to reset and re-search at any time

## Build

```bash
bun install
bun run build:atlas-ui
```

## Architecture

```
src/
  core/       Vault parser, graph builder, search, layout engine, graph algorithms.
              Zero cloud dependencies. This is the open-source core.
  frontend/   Sigma.js + graphology browser app. Dual-graph architecture for performance.
  power/      Remote adapter for vault-mcp-power (Cloudflare Worker with D1/Vectorize).
bench/        Performance benchmarks (layout, parsing).
```

`core/` has zero imports from `power/` or `frontend/`.

## Graph algorithms

All algorithms run during graph build on the server and ship as node attributes in the API response:

| Algorithm | What it computes | Time (8.5K nodes) |
|-----------|-----------------|-------------------|
| Louvain | Community detection (cluster IDs, modularity) | 13ms |
| PageRank | Node centrality (rank per node) | 16ms |
| Connected Components | Graph connectivity (component IDs) | 1.7ms |
| Clustering Coefficient | Local clustering (per-node coefficient) | 12ms |

Additional algorithms available in `src/core/` but not wired into the server pipeline:

- Betweenness centrality (Brandes)
- Eigenvector centrality
- HITS (hubs and authorities)

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph` | GET | All nodes (with enrichment attributes) and edges |
| `/api/search?q=` | GET | Keyword search across titles, tags, frontmatter |
| `/api/note?path=` | GET | Raw markdown content for a single note |
| `/api/meta` | GET | Vault stats: node/edge counts, top tags, top folders |
| `/api/enrichments` | GET | Enrichment status: version, community count, last run |
| `/api/events` | GET | SSE stream for live reload notifications |
| `/api/reload` | POST | Trigger vault re-parse |

## Power mode

Atlas can connect to a remote Cloudflare Worker for persistent storage, semantic search, and graph algorithm enrichment via D1 + Vectorize.

Add `?power=https://your-worker.example.com` to the URL to switch modes.

## Performance

Measured on an 8,531-note Obsidian vault:

| Operation | Time |
|-----------|------|
| Parse vault | 360ms |
| Build edges | 40ms |
| FA3 layout (100 iterations) | 980ms |
| Enrichment (4 algorithms) | ~43ms |
| **Cold start total** | **~1.4s** |

## Key libraries

- [sigma](https://www.sigmajs.org/) v3 -- WebGL graph rendering
- [graphology](https://graphology.github.io/) -- graph data structure
- [gray-matter](https://github.com/jonschlinkert/gray-matter) -- YAML frontmatter parsing
- ForceAtlas3 -- custom FA2 layout engine in `src/core/forceatlas3.ts`, runs on server and in Web Worker

## License

MIT
