/**
 * Minimal ULID implementation for CF Workers.
 *
 * Does: generates lexicographically sortable 26-char IDs (Crockford base32).
 * Does NOT: decode, validate, or monotonically increment within same ms.
 * Use instead of: ulidx/ulid packages (avoids external dependency).
 *
 * Spec: https://github.com/ulid/spec — 10 chars timestamp + 16 chars random.
 *
 * Consumers: src/index.ts (applyOps INSERTs, backfillVaultOpsUlids, ingestRunId,
 * buildRunId), tests/ulid.test.ts.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, len: number): string {
  let str = "";
  let t = ms;
  for (let i = len; i > 0; i--) {
    const mod = t % 32;
    str = CROCKFORD[mod] + str;
    t = (t - mod) / 32;
  }
  return str;
}

// Reuse a single buffer for the random portion to reduce GC pressure
// during batch operations (e.g. backfillVaultOpsUlids).
const RAND_BUF = new Uint8Array(10); // ceil(16 * 5 / 8) = 10 bytes

function encodeRandom(len: number): string {
  crypto.getRandomValues(RAND_BUF);
  let bits = 0;
  let bitsCount = 0;
  let result = "";
  for (const byte of RAND_BUF) {
    bits = (bits << 8) | byte;
    bitsCount += 8;
    while (bitsCount >= 5 && result.length < len) {
      bitsCount -= 5;
      result += CROCKFORD[(bits >>> bitsCount) & 0x1f];
    }
  }
  return result;
}

/**
 * Generate a ULID. Optional seedTime overrides Date.now() — useful for
 * backfilling historical rows with time-preserving sort order.
 */
export function ulid(seedTime?: number): string {
  return encodeTime(seedTime ?? Date.now(), 10) + encodeRandom(16);
}
