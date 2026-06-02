# Cartographer

Turn your Obsidian vault into an interactive knowledge graph. Parses every markdown note, extracts structural relationships, runs graph algorithms, and renders a force-directed visualization you can explore in your browser.

No account required. No cloud. Just your vault.

![Full graph view — 48 notes, 5 communities detected by Louvain, ForceAtlas3 layout](https://github.com/multimail-dev/cartographer-obsidian-viz/releases/download/v0.1.0/cartographer-hero.png)

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

![Seeded view — "Knowledge Graph" note with its structural neighborhood, PageRank rank, community pressure, and inspector panel](https://github.com/multimail-dev/cartographer-obsidian-viz/releases/download/v0.1.0/cartographer-seeded.png)

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
```

## Development

```bash
bun install
bun run build
bun run local ~/path/to/vault
```

## License

MIT — see [LICENSE](LICENSE).
