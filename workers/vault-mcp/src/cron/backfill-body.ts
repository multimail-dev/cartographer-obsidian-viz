/**
 * backfill-body.ts — plan-E2 resumable body/content_hash backfill.
 *
 * Populates `body`, `word_count`, `content_hash`, `frontmatter`, and
 * `created_at` on `vault_nodes` rows that migration 0004 left NULL. Each
 * HTTP call processes one slice within the Worker wall-clock budget; the
 * operator polls until `status === "completed"`.
 *
 * State machine (full detail in docs/plans/2026-04-14-001-*):
 *
 *   algorithm ──CAS──▶ backfill ──(no more rows)──▶ algorithm (completed)
 *                        │
 *                        ├──(wall-clock)──▶ algorithm (in_progress, cursor retained)
 *                        └──(checkpoint fail)──▶ algorithm (error, cursor at prior page)
 *
 * Invariants:
 *   - Lease is ALWAYS released on every exit path (completion, in_progress, error).
 *   - Cursor checkpoint failure BREAKS the loop and surfaces in the response —
 *     never silently swallowed via .catch(() => {}). (Adversary RED CRITICAL #2.)
 *   - Wall-clock release UPDATE writes last_node_id + nodes_processed explicitly,
 *     self-contained regardless of the mid-loop checkpoint state.
 *     (Adversary RED CRITICAL #3.)
 *   - Cooldown gate runs INSIDE the lease (after CAS success) so the gate
 *     decision is coherent with the cursor-row visible to this lease holder.
 *     (Spec-flow F2 / Adversary RED CRITICAL #1.)
 *   - processedThisCall is incremented per-statement against batch result
 *     .success flags, NEVER by prepared-statement array length.
 *     (Adversary WARNING D1 batch atomicity.)
 */
import type { Env } from "../env";
import { hasPlan005VaultNodeColumns } from "../schema-probes";
import { parseFrontmatterExtended } from "../parse";

/** Parallel R2 GETs per sub-batch — honors the CF Worker connection limit. */
const SLICE_BATCH_SIZE = 5;
/** vault_nodes rows per D1 SELECT page. 50 rows = 10 sub-batches of 5 R2 reads. */
const SLICE_PAGE_SIZE = 50;
/** Wall-clock headroom before the 30s Worker hard limit. Matches enrich-algorithms. */
export const WALL_CLOCK_GUARD_MS = 25_000;
/** Seconds the backfill lease is held before a later call can reclaim it. */
const LEASE_SECONDS = 600;
/** Fresh-cycle cooldown between completed runs. */
const COOLDOWN_SECONDS = 86_400;
/** Max force-bypass invocations per hour (mirrors /api/enrich force bucket). */
const FORCE_LIMIT_PER_HOUR = 10;
/** word_count sentinel for files larger than SIZE_GUARD_BYTES. */
const SIZE_GUARD_BYTES = 1_000_000;
/**
 * If more than this fraction of a page is missing from R2, ABORT the slice
 * — the failure rate implies a systematic path-mismatch bug, not isolated
 * orphan rows. (Adversary WARNING — 5% threshold.)
 */
const MISSING_R2_ABORT_THRESHOLD = 0.05;

export interface BackfillSliceResult {
  status:
    | "in_progress"
    | "completed"
    | "skipped"
    | "rate_limit"
    | "not_implemented"
    | "lease_held";
  processedThisCall: number;
  skippedThisCall: number;
  missingFromR2ThisCall: number;
  elapsedMs: number;
  totalProcessed: number;
  totalSkipped: number;
  totalMissingFromR2: number;
  lastNodeId: string | null;
  cycleStartedAt: number;
  cycleCompletedAt: number | null;
  message?: string;
  leaseHolder?: { phase: string; leaseExpires: number };
}

function emptyResult(): BackfillSliceResult {
  return {
    status: "skipped",
    processedThisCall: 0,
    skippedThisCall: 0,
    missingFromR2ThisCall: 0,
    elapsedMs: 0,
    totalProcessed: 0,
    totalSkipped: 0,
    totalMissingFromR2: 0,
    lastNodeId: null,
    cycleStartedAt: 0,
    cycleCompletedAt: null,
  };
}

/** Lowercase hex SHA-256 — byte-identical to buildGraph/syncGraph. */
async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Strip frontmatter block for word-counting, matching buildGraph's ftsBody slice. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

async function releaseLeaseIdle(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE enrich_cursor SET phase = 'algorithm', lease_expires = 0 WHERE id = 1`,
  ).run().catch(() => {});
}

interface ForceBucket { bucket: string; count: number }

async function checkAndBumpForceBucket(env: Env): Promise<boolean> {
  const hourBucket = Math.floor(Date.now() / 3_600_000).toString();
  let counterRow: { value: string } | null = null;
  try {
    counterRow = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'backfill_force_bucket'`,
    ).first<{ value: string }>();
  } catch {
    return false;
  }
  let counter = 0;
  let currentBucket = hourBucket;
  if (counterRow?.value) {
    try {
      const parsed = JSON.parse(counterRow.value) as ForceBucket;
      if (parsed.bucket === hourBucket) {
        counter = parsed.count;
        currentBucket = parsed.bucket;
      }
    } catch { /* stale — reset */ }
  }
  if (counter >= FORCE_LIMIT_PER_HOUR) return true;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_force_bucket', ?, unixepoch())`,
  ).bind(JSON.stringify({ bucket: currentBucket, count: counter + 1 })).run().catch(() => {});
  return false;
}

export async function runBodyBackfillSlice(
  env: Env,
  force: boolean,
): Promise<BackfillSliceResult> {
  const startedAtMs = Date.now();

  // 1. Pre-0004 guard ------------------------------------------------------
  if (!(await hasPlan005VaultNodeColumns(env))) {
    return {
      ...emptyResult(),
      status: "not_implemented",
      message: "migration 0004 not yet applied — vault_nodes.body missing",
      elapsedMs: Date.now() - startedAtMs,
    };
  }

  // 2. Atomic lease claim FIRST (before any cooldown read). Cooldown
  //    evaluation happens INSIDE the lease so it is coherent with the
  //    cursor row visible to this holder. Two concurrent callers cannot
  //    both pass the cooldown gate because only one wins the CAS.
  //    (Spec-flow F2 / Adversary RED CRITICAL #1.)
  let claim;
  try {
    claim = await env.DB.prepare(
      `UPDATE enrich_cursor
         SET phase = 'backfill', lease_expires = unixepoch() + ?
         WHERE id = 1
           AND (phase = 'algorithm'
                OR (phase = 'backfill'
                    AND lease_expires IS NOT NULL
                    AND lease_expires > 0
                    AND lease_expires < unixepoch()))`,
    ).bind(LEASE_SECONDS).run();
  } catch (err) {
    return {
      ...emptyResult(),
      status: "not_implemented",
      message: `enrich_cursor missing (pre-migration?): ${String(err).slice(0, 120)}`,
      elapsedMs: Date.now() - startedAtMs,
    };
  }

  if ((claim.meta?.changes ?? 0) === 0) {
    const holder = await env.DB.prepare(
      `SELECT phase, lease_expires FROM enrich_cursor WHERE id = 1`,
    ).first<{ phase: string; lease_expires: number }>().catch(() => null);
    return {
      ...emptyResult(),
      status: "lease_held",
      message: `lease held by phase='${holder?.phase ?? "unknown"}'`,
      leaseHolder: {
        phase: holder?.phase ?? "unknown",
        leaseExpires: holder?.lease_expires ?? 0,
      },
      elapsedMs: Date.now() - startedAtMs,
    };
  }

  // 3. Read cursor state under the lease. After the CAS, no other writer
  //    can touch enrich_cursor until our lease expires, so this read is
  //    coherent with the gate decision.
  const cursor = await env.DB.prepare(
    `SELECT last_node_id, nodes_processed FROM enrich_cursor WHERE id = 1`,
  ).first<{ last_node_id: string | null; nodes_processed: number | null }>();

  const isMidCycle = cursor?.last_node_id !== null && cursor?.last_node_id !== undefined;
  let lastNodeId = cursor?.last_node_id ?? "";
  let cycleProcessed = cursor?.nodes_processed ?? 0;
  let cycleSkipped = 0;
  let cycleMissing = 0;
  let cycleStartedAt = 0;

  // 4. Cooldown gate (fresh cycles only; mid-cycle resumes bypass).
  if (!isMidCycle) {
    const lastBackfill = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'last_backfill_at'`,
    ).first<{ value: string }>().catch(() => null);
    const lastBackfillAt = lastBackfill ? parseInt(lastBackfill.value, 10) || 0 : 0;
    const nowSec = Math.floor(Date.now() / 1000);

    if (lastBackfillAt > 0 && nowSec - lastBackfillAt < COOLDOWN_SECONDS) {
      if (!force) {
        await releaseLeaseIdle(env);
        return {
          ...emptyResult(),
          status: "skipped",
          message: `cooldown active until unixepoch ${lastBackfillAt + COOLDOWN_SECONDS}`,
          elapsedMs: Date.now() - startedAtMs,
        };
      }
      const rateLimited = await checkAndBumpForceBucket(env);
      if (rateLimited) {
        await releaseLeaseIdle(env);
        return {
          ...emptyResult(),
          status: "rate_limit",
          message: `force bucket exhausted (${FORCE_LIMIT_PER_HOUR}/hour)`,
          elapsedMs: Date.now() - startedAtMs,
        };
      }
    }

    // Fresh cycle — stamp start marker and reset cumulative counters.
    // backfill_cycle_state is a JSON blob carrying the cycle-level counters
    // that enrich_cursor can't hold (skipped + missing). Read-modify-written
    // at each checkpoint; initialized here at 0. (Plan-E2 P3 fix — the
    // first-run summary stored only the final slice's per-call counts for
    // these two fields; now it accumulates across slices.)
    cycleStartedAt = nowSec;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_started_at', ?, unixepoch())`,
    ).bind(String(cycleStartedAt)).run().catch(() => {});
    await env.DB.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
    ).bind(JSON.stringify({ skipped: 0, missing: 0 })).run().catch(() => {});
    await env.DB.prepare(
      `UPDATE enrich_cursor SET nodes_processed = 0, last_node_id = NULL WHERE id = 1`,
    ).run().catch(() => {});
    cycleProcessed = 0;
    cycleSkipped = 0;
    cycleMissing = 0;
    lastNodeId = "";
  } else {
    // Mid-cycle resume — read the cycle start marker + counter state.
    const startRow = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'backfill_cycle_started_at'`,
    ).first<{ value: string }>().catch(() => null);
    cycleStartedAt = startRow ? parseInt(startRow.value, 10) || 0 : 0;
    const stateRow = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'backfill_cycle_state'`,
    ).first<{ value: string }>().catch(() => null);
    if (stateRow?.value) {
      try {
        const parsed = JSON.parse(stateRow.value) as { skipped?: number; missing?: number };
        cycleSkipped = parsed.skipped ?? 0;
        cycleMissing = parsed.missing ?? 0;
      } catch { /* fresh counters */ }
    }
  }

  let processedThisCall = 0;
  let skippedThisCall = 0;
  let missingFromR2ThisCall = 0;

  // 5. Slice loop under the lease. Each iteration reads a D1 page, fetches
  //    its notes from R2 in sub-batches of 5, batches the UPDATEs, and
  //    writes the cursor checkpoint before advancing.
  while (Date.now() - startedAtMs < WALL_CLOCK_GUARD_MS) {
    const page = await env.DB.prepare(
      `SELECT path, content_hash FROM vault_nodes
         WHERE path > ? AND path NOT GLOB '__*'
         ORDER BY path
         LIMIT ?`,
    ).bind(lastNodeId, SLICE_PAGE_SIZE).all<{ path: string; content_hash: string | null }>();

    const rows = page.results ?? [];

    if (rows.length === 0) {
      // Natural cycle completion — release lease, stamp cooldown, write summary.
      const nowSec = Math.floor(Date.now() / 1000);
      const totalProcessed = cycleProcessed + processedThisCall;
      const totalSkipped = cycleSkipped + skippedThisCall;
      const totalMissing = cycleMissing + missingFromR2ThisCall;
      const summary = {
        cycleStartedAt,
        cycleCompletedAt: nowSec,
        totalProcessed,
        totalSkipped,
        totalMissingFromR2: totalMissing,
        durationMs: Date.now() - startedAtMs,
      };
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE enrich_cursor
             SET phase = 'algorithm', lease_expires = 0, last_node_id = NULL, nodes_processed = ?
           WHERE id = 1`,
        ).bind(totalProcessed),
        env.DB.prepare(
          `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_backfill_at', ?, unixepoch())`,
        ).bind(String(nowSec)),
        env.DB.prepare(
          `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_backfill_summary', ?, unixepoch())`,
        ).bind(JSON.stringify(summary)),
        // Clear the cycle-state blob so the next fresh cycle starts at 0/0
        // rather than inheriting these counters. (P3 follow-up.)
        env.DB.prepare(
          `DELETE FROM meta WHERE key = 'backfill_cycle_state'`,
        ),
      ]);
      return {
        status: "completed",
        processedThisCall,
        skippedThisCall,
        missingFromR2ThisCall,
        elapsedMs: Date.now() - startedAtMs,
        totalProcessed,
        totalSkipped,
        totalMissingFromR2: totalMissing,
        lastNodeId: null,
        cycleStartedAt,
        cycleCompletedAt: nowSec,
        message: `cycle complete: ${totalProcessed} processed in ${summary.durationMs}ms`,
      };
    }

    // Sub-batch the page into groups of 5 for parallel R2 reads.
    let pageMissing = 0;
    for (let i = 0; i < rows.length; i += SLICE_BATCH_SIZE) {
      const subBatch = rows.slice(i, i + SLICE_BATCH_SIZE);
      const fetches = subBatch.map((row) => env.VAULT.get(row.path + ".md"));
      const objects = await Promise.all(fetches);

      const updateStmts: Array<{ stmt: D1PreparedStatement; rowPath: string }> = [];

      for (let j = 0; j < subBatch.length; j++) {
        const row = subBatch[j];
        const obj = objects[j];
        if (!obj) {
          missingFromR2ThisCall++;
          pageMissing++;
          continue;
        }

        const content = await obj.text();
        const newHash = await sha256Hex(content);

        if (row.content_hash === newHash) {
          skippedThisCall++;
          continue;
        }

        const tooLarge = obj.size > SIZE_GUARD_BYTES;
        const ftsBody = stripFrontmatter(content);
        const wordCount = tooLarge ? -1 : ftsBody.split(/\s+/).filter(Boolean).length;
        let frontmatterRaw: string | null = null;
        try {
          const parsed = parseFrontmatterExtended(content);
          frontmatterRaw = parsed ? JSON.stringify(parsed) : null;
        } catch {
          frontmatterRaw = null;
        }
        const uploadedIso = obj.uploaded ? obj.uploaded.toISOString() : new Date().toISOString();

        updateStmts.push({
          stmt: env.DB.prepare(
            `UPDATE vault_nodes
               SET body = ?, word_count = ?, content_hash = ?, frontmatter = ?,
                   created_at = COALESCE(created_at, ?)
             WHERE path = ?`,
          ).bind(content, wordCount, newHash, frontmatterRaw, uploadedIso, row.path),
          rowPath: row.path,
        });
      }

      if (updateStmts.length > 0) {
        try {
          const batchResults = await env.DB.batch(updateStmts.map((u) => u.stmt));
          for (const r of batchResults) {
            if (r?.success) processedThisCall++;
          }
        } catch (err) {
          // Abort the slice — release the lease at the prior checkpoint so
          // the next call can resume cleanly.
          const totalProcessed = cycleProcessed + processedThisCall;
          const totalSkipped = cycleSkipped + skippedThisCall;
          const totalMissing = cycleMissing + missingFromR2ThisCall;
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE enrich_cursor
                 SET phase = 'algorithm', lease_expires = 0,
                     last_node_id = ?, nodes_processed = ?
               WHERE id = 1`,
            ).bind(lastNodeId || null, totalProcessed),
            env.DB.prepare(
              `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
            ).bind(JSON.stringify({ skipped: totalSkipped, missing: totalMissing })),
          ]).catch(() => {});
          return {
            status: "in_progress",
            processedThisCall,
            skippedThisCall,
            missingFromR2ThisCall,
            elapsedMs: Date.now() - startedAtMs,
            totalProcessed,
            totalSkipped,
            totalMissingFromR2: totalMissing,
            lastNodeId: lastNodeId || null,
            cycleStartedAt,
            cycleCompletedAt: null,
            message: `D1 batch failed: ${String(err).slice(0, 120)}`,
          };
        }
      }
    }

    // Systematic R2-miss guard: if > threshold of the page is missing, a
    // path-reconstruction bug is more likely than isolated orphan rows.
    // Abort so the operator can investigate. (Adversary WARNING.)
    // Denominator is SLICE_PAGE_SIZE per the plan's literal formula, not
    // rows.length — small tail pages should not trip the guard.
    if (pageMissing / SLICE_PAGE_SIZE > MISSING_R2_ABORT_THRESHOLD) {
      const advanced = rows[rows.length - 1].path;
      const totalProcessed = cycleProcessed + processedThisCall;
      const totalSkipped = cycleSkipped + skippedThisCall;
      const totalMissing = cycleMissing + missingFromR2ThisCall;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE enrich_cursor
             SET phase = 'algorithm', lease_expires = 0,
                 last_node_id = ?, nodes_processed = ?
           WHERE id = 1`,
        ).bind(advanced, totalProcessed),
        env.DB.prepare(
          `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
        ).bind(JSON.stringify({ skipped: totalSkipped, missing: totalMissing })),
      ]).catch(() => {});
      return {
        status: "in_progress",
        processedThisCall,
        skippedThisCall,
        missingFromR2ThisCall,
        elapsedMs: Date.now() - startedAtMs,
        totalProcessed,
        totalSkipped,
        totalMissingFromR2: totalMissing,
        lastNodeId: advanced,
        cycleStartedAt,
        cycleCompletedAt: null,
        message: `aborted: ${pageMissing}/${rows.length} R2 misses exceed ${Math.round(MISSING_R2_ABORT_THRESHOLD * 100)}% threshold — probable path mismatch`,
      };
    }

    lastNodeId = rows[rows.length - 1].path;

    // Cursor checkpoint — if this fails, abort the loop rather than
    // silently swallow the error. A failed checkpoint would otherwise
    // advance lastNodeId in memory but not in D1, and the next call would
    // resume from a stale position. (Adversary RED CRITICAL #2.)
    //
    // Also persists the cumulative skipped/missing counters to
    // meta.backfill_cycle_state so a mid-cycle resume sees the true totals
    // and the final summary blob reflects them. (P3 follow-up — v1 stored
    // only per-call values here.)
    try {
      const cumulativeSkipped = cycleSkipped + skippedThisCall;
      const cumulativeMissing = cycleMissing + missingFromR2ThisCall;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE enrich_cursor
             SET last_node_id = ?, nodes_processed = ?, lease_expires = unixepoch() + ?
           WHERE id = 1`,
        ).bind(lastNodeId, cycleProcessed + processedThisCall, LEASE_SECONDS),
        env.DB.prepare(
          `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
        ).bind(JSON.stringify({ skipped: cumulativeSkipped, missing: cumulativeMissing })),
      ]);
    } catch (err) {
      console.warn("backfill cursor checkpoint failed:", String(err).slice(0, 160));
      break;
    }
  }

  // 6. Wall-clock budget exhausted (or checkpoint broke us out). Release
  //    the lease and write last_node_id + nodes_processed + cumulative
  //    skipped/missing counters EXPLICITLY — self-contained regardless of
  //    any prior checkpoint state. (Adversary RED CRITICAL #3 + P3 fix.)
  const totalProcessedAtExit = cycleProcessed + processedThisCall;
  const totalSkippedAtExit = cycleSkipped + skippedThisCall;
  const totalMissingAtExit = cycleMissing + missingFromR2ThisCall;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE enrich_cursor
         SET phase = 'algorithm', lease_expires = 0,
             last_node_id = ?, nodes_processed = ?
       WHERE id = 1`,
    ).bind(lastNodeId || null, totalProcessedAtExit),
    env.DB.prepare(
      `INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('backfill_cycle_state', ?, unixepoch())`,
    ).bind(JSON.stringify({ skipped: totalSkippedAtExit, missing: totalMissingAtExit })),
  ]).catch((err) => {
    console.warn("backfill lease release failed:", String(err).slice(0, 160));
  });

  return {
    status: "in_progress",
    processedThisCall,
    skippedThisCall,
    missingFromR2ThisCall,
    elapsedMs: Date.now() - startedAtMs,
    totalProcessed: totalProcessedAtExit,
    totalSkipped: totalSkippedAtExit,
    totalMissingFromR2: totalMissingAtExit,
    lastNodeId: lastNodeId || null,
    cycleStartedAt,
    cycleCompletedAt: null,
    message: `wall-clock budget exhausted; resume at ${lastNodeId}`,
  };
}
