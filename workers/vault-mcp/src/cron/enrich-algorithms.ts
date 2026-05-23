/**
 * Algorithm enrichment phase — runs Louvain, PageRank, Connected Components,
 * and Clustering Coefficient on the full vault graph, writes results to D1.
 *
 * Only runs when enrich_cursor.phase = 'algorithm' (set by the embedding
 * phase when all nodes are embedded). After completion, resets phase to
 * 'embedding' for the next cycle.
 *
 * Ingest-guard: before writing results, checks if last_ingest_run_id changed
 * since the algorithm read started. If it did, discards results and returns —
 * next cron cycle will re-run with fresh data.
 *
 * Snapshot pruning: keeps MAX_SNAPSHOT_VERSIONS (52) versions in vault_snapshots;
 * rows older than (current_version - 52) are deleted after each successful run.
 *
 * DOES NOT:
 *   - Run Betweenness (529ms, deferred to on-demand)
 *   - Run HITS or Eigenvector (redundant with PageRank on undirected graphs)
 *   - Compute FA2-BH layout (stays browser-side in Web Worker)
 *
 * Schema tables used:
 *   vault_nodes        — source of truth for node paths (path TEXT PRIMARY KEY)
 *   vault_edges        — source of truth for edges (source TEXT, target TEXT, weight REAL)
 *   vault_enrichment   — enrichment side table (path TEXT PRIMARY KEY)
 *   meta               — key-value store (enrichment_version, last_ingest_run_id, etc.)
 *   enrich_cursor      — single-row cursor for phase/lease tracking
 *   vault_snapshots    — per-node per-version drift history (pruned to 52 versions)
 */
import type { Env } from "../env";
import { pagerank, louvain, connectedComponents, clusteringCoefficient } from "../algorithms";

export interface EnrichmentResult {
  status: "skipped" | "done" | "ingest_conflict" | "error";
  elapsedMs: number;
  nodeCount: number;
  communityCount: number;
  componentCount: number;
  error?: string;
}

// Alias for backwards-compat with callers that used the vault-mcp-power name
export type AlgorithmResult = EnrichmentResult;

const WALL_CLOCK_GUARD_MS = 25_000;
// D1's batch endpoint rejects >100 statements at a time. The rest of the
// worker chunks writes at 80–100 per batch; enrichment must match so the
// weekly cron does not fail on vaults with more than ~100 nodes.
// (Codex round-42 P1 finding.)
const BATCH_SIZE = 100;
/** Maximum number of enrichment-version snapshot rows to retain per node. */
const MAX_SNAPSHOT_VERSIONS = 52;
/** Lease duration for an in-flight enrichment run. If a cron isolate is
 *  terminated mid-run before it can reset `phase = 'algorithm'`, the lease
 *  expires and the next scheduled run can reclaim the cursor instead of
 *  wedging forever. Must comfortably exceed the WALL_CLOCK_GUARD_MS budget.
 *  (Codex round-41 P1 finding.) */
const CLAIM_LEASE_SECONDS = 600;

export async function runAlgorithmEnrichment(env: Env): Promise<EnrichmentResult> {
  const startedAt = Date.now();

  try {
    // Atomic phase claim — prevents double-run from concurrent cron invocations.
    // Only one isolate can transition phase to 'running_algorithms'. The claim
    // now honors a lease: a cursor stuck at 'running_algorithms' whose
    // lease_expires is in the past (or zero) is considered abandoned and can
    // be reclaimed, so a crashed isolate does not wedge enrichment forever.
    // Inside try/catch so pre-migration-0004 databases without enrich_cursor
    // degrade gracefully. (Codex P2 round-17 finding; round-41 P1 lease fix.)
    let claimed;
    try {
      // Reclaim rules:
      //   - phase = 'algorithm' → normal claim
      //   - phase = 'running_algorithms' with a SET, EXPIRED lease → crashed run, reclaim
      //   - phase = 'running_algorithms' with NULL lease → treated as legit in-flight
      //     (test fixtures + old-code rollout window seed NULL; we never reclaim them)
      //   - phase = 'backfill' with a SET, EXPIRED lease → crashed plan-E2
      //     backfill run, reclaim. Symmetric to the backfill handler, which
      //     reclaims abandoned 'running_algorithms' leases the same way —
      //     without this mirror clause, an abandoned backfill lease would
      //     wedge the weekly enrichment cron forever. (Plan-E2 blocking
      //     acceptance criterion; adversary WARNING #5.)
      claimed = await env.DB.prepare(
        `UPDATE enrich_cursor
         SET phase = 'running_algorithms', lease_expires = unixepoch() + ?
         WHERE id = 1
           AND (phase = 'algorithm'
                OR (phase = 'running_algorithms'
                    AND lease_expires IS NOT NULL
                    AND lease_expires > 0
                    AND lease_expires < unixepoch())
                OR (phase = 'backfill'
                    AND lease_expires IS NOT NULL
                    AND lease_expires > 0
                    AND lease_expires < unixepoch()))`,
      ).bind(CLAIM_LEASE_SECONDS).run();
    } catch (err) {
      console.warn("enrich_cursor missing (pre-migration?); skipping enrichment:", String(err).slice(0, 120));
      return { status: "skipped", elapsedMs: 0, nodeCount: 0, communityCount: 0, componentCount: 0 };
    }
    if ((claimed.meta?.changes ?? 0) === 0) {
      return { status: "skipped", elapsedMs: 0, nodeCount: 0, communityCount: 0, componentCount: 0 };
    }
    // Snapshot the ingest run ID before reading graph data.
    // ingestRunIdRaw is the literal meta row value (may be JSON-encoded, e.g. '"run-A"').
    // ingestRunId is the unwrapped string used for equality checks and subquery binding.
    //
    // Also refuse to run if ANY ingest is currently 'running' — meta.last_ingest_run_id
    // is advanced at ingest start, so it stays stable throughout an in-progress
    // sync. Without this check, the before/after id equality holds and the
    // post-compute guard would let us publish scores against a partially-written
    // graph. (Codex P1 round-15 finding.)
    // Wrap in try/catch to tolerate test shims or pre-migration databases where
    // ingest_runs may not exist — treat absence as "no in-flight ingest".
    // 1-hour staleness bound: if a syncGraph run crashed before updating
    // ingest_runs.status, its row would block all enrichment forever.
    // Any sync that takes >1h is pathological and we'd rather enrich than
    // block indefinitely. (Codex P1 round-19 finding.)
    let runningIngest: { id: string } | null = null;
    try {
      runningIngest = await env.DB.prepare(
        // Partial syncs (SYNC_LIMIT hit mid-batch) mark ingest_runs status as
        // 'partial' until the follow-up sync call completes. Enrichment must
        // treat them as still in-flight, otherwise a large multi-batch sync
        // leaves a gap where the orchestrator sees no 'running' row and
        // publishes scores against a partially refreshed graph.
        // (Codex round-40 P1 finding.)
        `SELECT id FROM ingest_runs
         WHERE status IN ('running', 'partial') AND started_at > (unixepoch() - 3600)
         LIMIT 1`,
      ).first<{ id: string }>();
    } catch { /* table missing — no in-flight ingest */ }
    if (runningIngest) {
      console.warn(`algorithm enrichment: ingest ${runningIngest.id} is in-flight, deferring`);
      await env.DB.prepare(
        `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
      ).run().catch(() => {});
      return { status: "skipped", elapsedMs: Date.now() - startedAt, nodeCount: 0, communityCount: 0, componentCount: 0 };
    }

    // Meta read is wrapped in try/catch so a pre-0004 database (no meta table)
    // skips cleanly instead of throwing. (Self-review round-31 — caught by
    // cross-seam transition-window test.)
    let ingestBefore: { value: string } | null = null;
    try {
      ingestBefore = await env.DB.prepare(
        `SELECT value FROM meta WHERE key = 'last_ingest_run_id'`,
      ).first<{ value: string }>();
    } catch (err) {
      console.warn("meta table missing (pre-migration-0004?); skipping enrichment:", String(err).slice(0, 120));
      await env.DB.prepare(
        `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
      ).run().catch(() => {});
      return { status: "skipped", elapsedMs: Date.now() - startedAt, nodeCount: 0, communityCount: 0, componentCount: 0 };
    }
    const ingestRunIdRaw = ingestBefore?.value ?? "";
    let ingestRunId = ingestRunIdRaw;
    try { ingestRunId = JSON.parse(ingestRunIdRaw) as string; } catch { /* use raw */ }

    // Read all nodes and edges from D1.
    // vault_nodes primary key is `path`; vault_edges uses `source` / `target`.
    // Sentinel rows (`__last_sync__`, `__last_build_completed__`, etc.) must be
    // excluded — they would produce bogus singleton communities and inflate
    // every count the orchestrator reports. Read paths use `path NOT GLOB '__*'`
    // to hide them; algorithms must match.
    // (Codex P2 round-2 finding.)
    // Aggregate edge weights across edge_type AND undirected direction —
    // vault_edges is unique on (source, target, edge_type), so a pair can
    // appear up to 2 × |edge_types| times when reciprocal. The enrichment
    // algorithms treat the graph as undirected, so we canonicalize the pair
    // with MIN/MAX before GROUP BY. Without this, a mutual wikilink between
    // A and B is inserted twice into CSR adjacency, doubling its weight in
    // pagerank and triangle counts.
    // (Codex P1 round-8 + round-14 findings.)
    const [nodesRes, edgesRes] = await Promise.all([
      env.DB.prepare(`SELECT path FROM vault_nodes WHERE path NOT GLOB '__*' ORDER BY path`).all<{ path: string }>(),
      env.DB.prepare(
        `SELECT
            CASE WHEN source < target THEN source ELSE target END AS source,
            CASE WHEN source < target THEN target ELSE source END AS target,
            SUM(weight) AS weight
         FROM vault_edges
         WHERE source NOT GLOB '__*' AND target NOT GLOB '__*'
         GROUP BY
            CASE WHEN source < target THEN source ELSE target END,
            CASE WHEN source < target THEN target ELSE source END`
      ).all<{
        source: string;
        target: string;
        weight: number;
      }>(),
    ]);

    const nodeIds = (nodesRes.results ?? []).map((r) => r.path);
    const rawEdges = edgesRes.results ?? [];
    const nodeCount = nodeIds.length;

    if (nodeCount === 0) {
      // Clear stale enrichment state when the live graph becomes empty —
      // otherwise /api/enrichments + /api/meta keep reporting the last
      // non-empty run forever. (Codex P2 round-8 finding.)
      // Do the wipe against whichever enrichment table exists.
      const emptyEnrichTableRow = await env.DB.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('vault_enrichment', 'vault_centrality')
         ORDER BY CASE WHEN name = 'vault_enrichment' THEN 0 ELSE 1 END
         LIMIT 1`,
      ).first<{ name: string }>().catch(() => null);
      if (emptyEnrichTableRow?.name) {
        await env.DB.prepare(`DELETE FROM ${emptyEnrichTableRow.name}`).run().catch(() => {});
      }
      const nowEmptySec = Math.floor(Date.now() / 1000);
      await env.DB.batch([
        env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_version', '0', unixepoch())`),
        env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_enrichment_at', ?, unixepoch())`).bind(String(nowEmptySec)),
        env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_community_count', '0', unixepoch())`),
        env.DB.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`),
      ]).catch(() => {});
      return { status: "done", elapsedMs: Date.now() - startedAt, nodeCount: 0, communityCount: 0, componentCount: 0 };
    }

    // Build integer-index mapping (algorithms work on 0-based integer node IDs)
    const idToIndex = new Map<string, number>();
    nodeIds.forEach((id, i) => idToIndex.set(id, i));

    // Build edge list in algorithm format
    const algoEdges: Array<{ source: number; target: number; weight: number }> = [];
    for (const e of rawEdges) {
      const si = idToIndex.get(e.source);
      const ti = idToIndex.get(e.target);
      if (si !== undefined && ti !== undefined && si !== ti) {
        algoEdges.push({ source: si, target: ti, weight: e.weight });
      }
    }

    // Run algorithms (synchronous; Louvain has no abort hook — see C9 note below)
    //
    // C9 — Louvain wall-clock guard:
    //   louvain.ts Phase 1 is a `while (changed)` loop with no AbortSignal or
    //   time-check hook. On the vault graph (≤5 000 nodes) it completes in <5 000ms.
    //   If the graph grows to >20 000 nodes this becomes a blocker. To add the guard,
    //   insert the following check at the TOP of the `while (changed)` block in
    //   workers/vault-mcp/src/algorithms/louvain.ts line 98:
    //
    //     if (Date.now() - louvainStart > 20_000) { changed = false; break; }
    //
    //   louvainStart must be captured with `const louvainStart = Date.now();` just
    //   before `let changed = true;` on line 97. The outer wall-clock guard at
    //   WALL_CLOCK_GUARD_MS=25s will catch runaway cases for now.
    const t1 = performance.now();
    const cc = connectedComponents(nodeCount, algoEdges);
    const lv = louvain(nodeCount, algoEdges);
    const pr = pagerank(nodeCount, algoEdges);
    const cl = clusteringCoefficient(nodeCount, algoEdges);
    const algoMs = performance.now() - t1;
    console.log(`algorithms: ${algoMs.toFixed(0)}ms (${nodeCount} nodes, ${algoEdges.length} edges)`);

    // Remap raw Louvain community labels (integer indices into the current
    // node list) to STABLE cluster IDs derived from the canonical (lowest-
    // sorted path) member of each community. Without this, inserting or
    // renaming any note ahead of an existing community would renumber every
    // cluster_id even though the partition did not change, and
    // /api/vault/drift + /api/vault/propagate would report false "cluster
    // changed" noise across enrichment versions. Community count is unchanged.
    // (Codex P1 round-9 finding.)
    //
    // Stable ID derivation: hash the canonical-path string into a 31-bit
    // integer (INTEGER column in SQLite — stable across runs for the same
    // string, collision-tolerant at 10k-node scale). Same canonical path →
    // same id across runs.
    const communityCanonical: Map<number, string> = new Map();
    for (let i = 0; i < nodeCount; i++) {
      const label = lv.communities[i];
      const existing = communityCanonical.get(label);
      if (existing === undefined || nodeIds[i] < existing) {
        communityCanonical.set(label, nodeIds[i]);
      }
    }
    const hashPath = (s: string): number => {
      // Simple FNV-1a 32-bit hash, masked to 31 bits so the value fits in a
      // signed INTEGER column and stays positive.
      let h = 0x811c9dc5;
      for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return h & 0x7fffffff;
    };
    const labelToStableId: Map<number, number> = new Map();
    for (const [label, canonicalPath] of communityCanonical.entries()) {
      labelToStableId.set(label, hashPath(canonicalPath));
    }
    const stableCluster = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      stableCluster[i] = labelToStableId.get(lv.communities[i]) ?? 0;
    }
    // Same treatment for components — rarer, but the principle is the same.
    const componentCanonical: Map<number, string> = new Map();
    for (let i = 0; i < nodeCount; i++) {
      const label = cc.components[i];
      const existing = componentCanonical.get(label);
      if (existing === undefined || nodeIds[i] < existing) {
        componentCanonical.set(label, nodeIds[i]);
      }
    }
    const componentLabelToStable: Map<number, number> = new Map();
    for (const [label, canonicalPath] of componentCanonical.entries()) {
      componentLabelToStable.set(label, hashPath(canonicalPath));
    }
    const stableComponent = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      stableComponent[i] = componentLabelToStable.get(cc.components[i]) ?? 0;
    }

    // Wall-clock guard — 25s total (5s headroom before CF 30s worker limit).
    // Must reset phase back to 'algorithm' or the next cron claim starves.
    // (Codex P1 round-3 finding: wall-clock path previously returned without
    // restoring a claimable phase.)
    if (Date.now() - startedAt > WALL_CLOCK_GUARD_MS) {
      console.warn("algorithm enrichment: wall-clock guard hit, discarding results");
      await env.DB.prepare(
        `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
      ).run().catch(() => {});
      return { status: "error", elapsedMs: Date.now() - startedAt, nodeCount, communityCount: 0, componentCount: 0, error: "wall-clock guard" };
    }

    // Ingest-guard: check if last_ingest_run_id changed during computation.
    // If it changed, a new ingest landed while we were computing — discard results.
    const ingestAfter = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'last_ingest_run_id'`,
    ).first<{ value: string }>();
    const afterIdRaw = ingestAfter?.value ?? "";
    let afterId = afterIdRaw;
    try { afterId = JSON.parse(afterIdRaw) as string; } catch { /* use raw */ }
    if (afterId !== ingestRunId) {
      console.warn("algorithm enrichment: ingest landed during computation, discarding results");
      await env.DB.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`).run();
      return { status: "ingest_conflict", elapsedMs: Date.now() - startedAt, nodeCount, communityCount: 0, componentCount: 0 };
    }

    // Second guard: an ingest may have STARTED during compute without
    // advancing the meta id further (rare, but possible on overlapping calls).
    // If any ingest_runs row is still running, the graph we just read is
    // potentially inconsistent. Abort. (Codex P1 round-15 finding.)
    let midRunIngest: { id: string } | null = null;
    try {
      midRunIngest = await env.DB.prepare(
        // Partial syncs (SYNC_LIMIT hit mid-batch) mark ingest_runs status as
        // 'partial' until the follow-up sync call completes. Enrichment must
        // treat them as still in-flight, otherwise a large multi-batch sync
        // leaves a gap where the orchestrator sees no 'running' row and
        // publishes scores against a partially refreshed graph.
        // (Codex round-40 P1 finding.)
        `SELECT id FROM ingest_runs
         WHERE status IN ('running', 'partial') AND started_at > (unixepoch() - 3600)
         LIMIT 1`,
      ).first<{ id: string }>();
    } catch { /* table missing */ }
    if (midRunIngest) {
      console.warn(`algorithm enrichment: ingest ${midRunIngest.id} started during compute, discarding`);
      await env.DB.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`).run();
      return { status: "ingest_conflict", elapsedMs: Date.now() - startedAt, nodeCount, communityCount: 0, componentCount: 0 };
    }

    // Prune stale enrichment rows for notes that no longer exist in vault_nodes.
    // Without this, deleted notes remain in vault_enrichment and surface in
    // detectCentralityShifts/detectAccessDivergence + inflate community counts.
    // The legacy computeCentrality() path explicitly deleted stale rows.
    // (Codex P1 round-7 finding.)
    // Done before resolving the table name below because the DELETE is safe
    // against either legacy or new name — we re-resolve inside the block.
    // Resolve the enrichment table name. During the plan-B9 transition window,
    // pre-0005 databases still have `vault_centrality`; post-0005 have
    // `vault_enrichment`. Hard-coding either name would fail enrichment on the
    // other side of the window.
    // (Codex P1 round-6 finding.)
    const enrichTableRow = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('vault_enrichment', 'vault_centrality')
       ORDER BY CASE WHEN name = 'vault_enrichment' THEN 0 ELSE 1 END
       LIMIT 1`,
    ).first<{ name: string }>();
    const enrichTable = enrichTableRow?.name;
    if (enrichTable === "vault_enrichment" || enrichTable === "vault_centrality") {
      // Probe whether the 0004 extension columns exist. Pre-0004 vault_centrality
      // has only pagerank/prev_pagerank/computed_at — the round-23 UPSERT writes
      // 7 columns and would throw on a pre-migration table. Exit gracefully so
      // the orchestrator can be deployed before 0004 applies (the plan B10
      // sequence). (Self-review round-26 finding.)
      try {
        const cols = await env.DB.prepare(`PRAGMA table_info('${enrichTable}')`).all<{ name: string }>();
        const names = new Set((cols.results ?? []).map((r) => r.name));
        const needed = ["cluster_id", "component_id", "clustering_coeff"];
        if (!needed.every((c) => names.has(c))) {
          console.warn(
            `algorithm enrichment: ${enrichTable} missing extension columns (needs ${needed.join(",")}); skipping until migration 0004 applies`,
          );
          await env.DB.prepare(
            `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
          ).run().catch(() => {});
          return {
            status: "skipped",
            elapsedMs: Date.now() - startedAt,
            nodeCount: 0,
            communityCount: 0,
            componentCount: 0,
          };
        }
      } catch (err) {
        console.warn("enrichment column probe failed:", String(err).slice(0, 160));
      }

      // Purge enrichment rows for paths that no longer exist as live
      // (non-sentinel) nodes. Safe to run unconditionally — DELETE is idempotent.
      await env.DB.prepare(
        `DELETE FROM ${enrichTable}
         WHERE path NOT IN (SELECT path FROM vault_nodes WHERE path NOT GLOB '__*')`,
      ).run().catch((err) => {
        console.warn("enrichment stale-row prune failed:", String(err).slice(0, 160));
      });
    }
    if (enrichTable !== "vault_enrichment" && enrichTable !== "vault_centrality") {
      console.warn("algorithm enrichment: no enrichment table found, aborting");
      await env.DB.prepare(
        `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
      ).run().catch(() => {});
      return {
        status: "error",
        elapsedMs: Date.now() - startedAt,
        nodeCount,
        communityCount: 0,
        componentCount: 0,
        error: "no enrichment table",
      };
    }

    // Batch UPSERT into the enrichment side table.
    // Sum rows-changed across all UPDATE batches. If the per-row race guard
    // (WHERE (SELECT value FROM meta WHERE key = 'last_ingest_run_id') = ?)
    // silently no-ops every UPDATE because a concurrent ingest advanced the
    // meta id after the post-algo guard check, we must detect it and abort.
    // Otherwise the function would bump enrichment_version and write snapshots
    // while vault_enrichment holds only placeholder zero rows from the
    // INSERT OR IGNORE, surfacing a "successful" run backed by zeroed data.
    // (Codex P1 round-5 finding.)
    // Single-statement UPSERT per row, consolidating the round-5 insert-then-
    // update pair into one batch iteration. At 10k-node vault-graph scale,
    // the split pattern cost ~6.5s extra (86 write batches vs 43), chewing
    // into the 25s wall-clock budget. ON CONFLICT DO UPDATE ... WHERE preserves
    // the race guard (WHERE fails → 0 rows changed → round-6 partial-drop
    // guard still fires). `pagerank` on the right of SET refers to the
    // EXISTING row value per SQLite semantics, so prev_pagerank carry-forward
    // still works. `excluded.*` refers to the candidate row values.
    // (Self-review round-23 finding — budget headroom restoration.)
    let updatedRowCount = 0;
    for (let i = 0; i < nodeCount; i += BATCH_SIZE) {
      const end = Math.min(i + BATCH_SIZE, nodeCount);
      const upsertStmts = [];
      for (let j = i; j < end; j++) {
        // Race guard must apply to INSERT as well as UPDATE. VALUES (...) runs
        // unconditionally; INSERT ... SELECT ... WHERE makes the INSERT side
        // conditional on `meta.last_ingest_run_id` still matching the snapshot
        // taken before compute. Suppressed rows drop `changes` to 0, and the
        // post-loop `updatedRowCount < nodeCount` check aborts before the
        // version bump. (Codex round-40 P1 finding: ON CONFLICT DO UPDATE
        // WHERE only guards UPDATE — first-ever enrichment rows bypassed it.)
        upsertStmts.push(
          env.DB.prepare(
            `INSERT INTO ${enrichTable}
               (path, pagerank, prev_pagerank, computed_at, cluster_id, component_id, clustering_coeff)
             SELECT ?, ?, 0, unixepoch(), ?, ?, ?
             WHERE (SELECT value FROM meta WHERE key = 'last_ingest_run_id') = ?
             ON CONFLICT(path) DO UPDATE SET
               prev_pagerank = pagerank,
               pagerank = excluded.pagerank,
               cluster_id = excluded.cluster_id,
               component_id = excluded.component_id,
               clustering_coeff = excluded.clustering_coeff,
               computed_at = unixepoch()
             WHERE (SELECT value FROM meta WHERE key = 'last_ingest_run_id') = ?`,
          ).bind(
            nodeIds[j],
            pr[j],
            stableCluster[j],
            stableComponent[j],
            cl.coefficients[j],
            ingestRunIdRaw,
            ingestRunIdRaw,
          ),
        );
      }
      const results = await env.DB.batch(upsertStmts);
      for (const r of results) {
        updatedRowCount += (r.meta?.changes ?? 0);
      }
    }

    // If ANY row was dropped by the race guard (not just all rows), we cannot
    // publish the run — the resulting enrichment_version would mix fresh and
    // stale scores. Abort before bumping version + writing snapshots.
    // (Codex P1 round-6 finding: round-5 only caught all-zero.)
    if (updatedRowCount < nodeCount) {
      console.warn(
        `algorithm enrichment: per-row race guard dropped ${nodeCount - updatedRowCount}/${nodeCount} UPDATEs, aborting before version bump`,
      );
      await env.DB.prepare(
        `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`
      ).run().catch(() => {});
      return {
        status: "ingest_conflict",
        elapsedMs: Date.now() - startedAt,
        nodeCount,
        communityCount: 0,
        componentCount: 0,
      };
    }

    // Update meta: enrichment_version++, last_enrichment_at, community_count
    // All meta.updated_at values across the codebase use unixepoch() (seconds)
    // and meta.value for timestamps is ALSO written as unix seconds as a
    // string. Orchestrator previously wrote Date.now() millis, which broke
    // unit consistency with buildGraph/syncGraph writers. (Self-review round-20.)
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const existingVersion = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'enrichment_version'`,
    ).first<{ value: string }>();
    const version = existingVersion ? parseInt(existingVersion.value, 10) + 1 : 1;

    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_version', ?, unixepoch())`).bind(String(version)),
      env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_enrichment_at', ?, unixepoch())`).bind(String(nowSec)),
      env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('enrichment_community_count', ?, unixepoch())`).bind(String(lv.communityCount)),
      // Reset phase back to 'algorithm' so the next weekly cron run can claim
      // work. The original vault-mcp-power design transitioned embedding→algorithm
      // via the embedding cron, but vault-mcp has Vectorize deferred — there is
      // no embedding phase to drive the transition, so we close the cycle here.
      // (Codex P1 round-2 finding.)
      env.DB.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`),
    ]);

    // Append vault_snapshots for drift visualization.
    // One row per node per enrichment run. Skipped silently if the table
    // does not yet exist (pre-migration environments).
    try {
      for (let i = 0; i < nodeCount; i += BATCH_SIZE) {
        const end = Math.min(i + BATCH_SIZE, nodeCount);
        const stmts = [];
        for (let j = i; j < end; j++) {
          // captured_at is NOT NULL in migration 0004 — must be bound explicitly.
          // Epoch millis per the B6a schema comment.
          // (Codex P1 round-2 finding.)
          stmts.push(
            env.DB.prepare(
              `INSERT INTO vault_snapshots (node_id, enrichment_version, captured_at, pagerank, cluster_id, component_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).bind(nodeIds[j], version, nowMs, pr[j], stableCluster[j], stableComponent[j]),
          );
        }
        await env.DB.batch(stmts);
      }
    } catch (err) {
      // Table missing or write failed — drift visualization will simply show
      // no history. Not worth blocking the enrichment cycle.
      console.warn("vault_snapshots append skipped:", String(err).slice(0, 120));
    }

    // Snapshot pruning: retain exactly MAX_SNAPSHOT_VERSIONS (52) versions
    // including the current one. Keep versions [version - 51, version] —
    // that's 52 rows. The < operator gives us that boundary exactly.
    // (Codex P3 round-15 off-by-one finding.)
    try {
      const pruneBelow = version - MAX_SNAPSHOT_VERSIONS + 1;
      if (pruneBelow > 0) {
        await env.DB.prepare(
          `DELETE FROM vault_snapshots WHERE enrichment_version < ?`,
        ).bind(pruneBelow).run();
      }
    } catch (err) {
      console.warn("vault_snapshots pruning skipped:", String(err).slice(0, 120));
    }

    console.log(`algorithm enrichment complete: v${version}, ${lv.communityCount} communities, ${cc.count} components`);

    return {
      status: "done",
      elapsedMs: Date.now() - startedAt,
      nodeCount,
      communityCount: lv.communityCount,
      componentCount: cc.count,
    };
  } catch (err) {
    console.error("algorithm enrichment error:", err);
    // Reset phase so we don't get stuck
    await env.DB.prepare(`UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`).run().catch(() => {});
    return {
      status: "error",
      elapsedMs: Date.now() - startedAt,
      nodeCount: 0,
      communityCount: 0,
      componentCount: 0,
      error: String(err).slice(0, 200),
    };
  }
}
