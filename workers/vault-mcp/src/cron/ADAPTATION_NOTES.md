# Adaptation Notes — enrich-algorithms.ts port (plan005 D1)

Source: `workers/vault-mcp-power/src/worker/cron/enrich-algorithms.ts` (190 LOC)
Target: `workers/vault-mcp/src/cron/enrich-algorithms.ts` (251 LOC)

## (a) Line-by-line changes from original 190 LOC

| Original line(s) | Change | Reason |
|---|---|---|
| 18 | `import type { Env } from "../env.ts"` → `import type { Env } from "../env"` | vault-mcp uses relative import without .ts extension per bundler resolution; env.ts is in parent `src/` dir |
| 19–22 | Individual algorithm imports → barrel import from `../algorithms` | Plan checklist item 9; barrel at `src/algorithms/index.ts` exports all four |
| 58–64 | `SELECT id FROM nodes` → `SELECT path FROM vault_nodes`; `SELECT source_id, target_id, weight FROM edges` → `SELECT source, target, weight FROM vault_edges` | vault-mcp uses `vault_nodes`/`vault_edges` table names; PK is `path` not `id`; columns are `source`/`target` not `source_id`/`target_id` (T1) |
| 66 | `.map((r) => r.id)` → `.map((r) => r.path)` | PK column rename |
| 81–87 | `e.source_id` / `e.target_id` → `e.source` / `e.target` | T1 column rename |
| 123–125 | `UPDATE nodes SET ... WHERE id = ? AND ingest_run_id = ?` → `UPDATE vault_enrichment SET ... WHERE path = ? AND (SELECT value FROM meta WHERE key = 'last_ingest_run_id') = ?` | vault_enrichment has no `ingest_run_id` column; ingest guard preserved via meta subquery (S7); uses `ingestRunIdRaw` (raw stored value) for subquery equality |
| Added | `ingestRunIdRaw` variable separate from `ingestRunId` | meta stores JSON-encoded strings; subquery must match raw value; unwrapped value used for equality check |
| Added | `MAX_SNAPSHOT_VERSIONS = 52` constant + post-run pruning block | Plan checklist item 7 |
| Added | C9 inline TODO comment explaining where/how to add Louvain guard | See section (c) below |
| Return type | `AlgorithmResult` → `EnrichmentResult` (with `AlgorithmResult` alias kept) | Rename for vault-mcp naming convention; alias preserves vault-mcp-power caller compat |

## (b) Env import site

`Env` is imported from `"../env"` — the `src/env.ts` file in the vault-mcp package.
`index.ts` re-exports it (`export type { Env }` on line 13) but importing from `../env`
directly avoids a circular-import risk since index.ts is large and imports from many
sub-modules. The `env.ts` file has no dependencies on cron code.

## (c) Louvain abort-signal / C9

`louvain.ts` has **no abort hook**. The Phase 1 `while (changed)` loop (line 98) is
fully synchronous with no time-check. For the current vault graph size (≤5 000 nodes)
this completes in <5 ms. The outer WALL_CLOCK_GUARD_MS=25 000ms guard will catch any
runaway case for now.

**To add the guard when graph size grows**, insert at `louvain.ts` line 98:

```typescript
// Before: let changed = true;
const louvainStart = Date.now();    // ← add this
let changed = true;
while (changed) {
  if (Date.now() - louvainStart > 20_000) { changed = false; break; }  // ← add this
  ...
```

Risk if not added before >20 000 node growth: louvain can hold the isolate for 500–2 000ms
beyond the 25s guard, causing the Worker to be terminated mid-batch-write and leaving
enrich_cursor in the `running_algorithms` stuck phase. The phase-reset in the catch block
handles this only if the Worker terminates cleanly (not always guaranteed at CF limit).
