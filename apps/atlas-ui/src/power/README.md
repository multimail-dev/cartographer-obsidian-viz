# src/power/

Power-mode adapter for a remote Cloudflare Worker that persists the vault graph to D1, computes embeddings in Vectorize, and serves it back through CF Access.

## Architecture

- `adapter.ts` — implements `GraphSource` (from `../core/types.ts`) via `fetch` against a vault-mcp-power worker
- **Zero cloud deps.** No wrangler, no CF Worker types, no auth libraries. Pure browser `fetch`.
- **Core isolation rule** (see repo CLAUDE.md): `core/` has zero imports from `power/`, `server/`, or `frontend/`. The adapter depends on core (one-way) but core knows nothing about power.

## Usage

```ts
import { createPowerSource } from "./power/adapter.ts";

const source = createPowerSource({
  baseUrl: "https://your-atlas-domain.com",
  // bearer: "test-secret",  // optional — omit to use CF Access session cookies
});

const graph = await source.load();                    // paginated /api/graph
const hits = await source.search("karpathy");         // /api/search
const markdown = await source.getNote("path/to/note"); // /api/note
```

## Bonus: semantic bridges

```ts
import { fetchBridges } from "./power/adapter.ts";

const res = await fetchBridges(
  { baseUrl: "https://your-atlas-domain.com" },
  "notes/a",
  "notes/b",
  { maxHops: 3, k: 5 },
);

if (res) {
  for (const path of res.paths) {
    console.log(path.nodes.join(" → "), "cost:", path.cost);
  }
}
```

## Frontend integration (planned)

The frontend will read a URL query param `?power=https://your-atlas-domain.com` and swap its `GraphSource` accordingly. Local mode remains the default — power mode is opt-in.

## What this adapter does NOT do

- Local markdown parsing (that's `src/core/parser.ts`)
- Layout computation (that's `src/core/forceatlas3.ts` or the web worker)
- Authentication flow (CF Access handles it via browser session, or pass a Bearer for headless use)
- MCP integration (power-mode v0.2 adds an MCP Durable Object in the worker)
