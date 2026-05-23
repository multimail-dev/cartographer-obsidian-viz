/**
 * SQLite backup utility for local graph database.
 *
 * Does: creates an atomic copy of the local SQLite DB using the online backup API.
 * Does NOT: manage backup rotation or versioning — single rolling .bak file.
 * Use instead of: cp/rsync on WAL-mode databases (which can produce corrupt copies).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Create an atomic backup of a SQLite database using the online backup API.
 * Safe for WAL-mode databases — produces a consistent snapshot even under
 * concurrent reads/writes.
 *
 * @param dbPath - Absolute path to the source SQLite database
 * @param backupPath - Optional override for backup destination.
 *                     Defaults to `<dbPath>.bak` (single rolling backup).
 * @returns The absolute path to the backup file
 */
export async function backupLocalDb(
  dbPath: string,
  backupPath?: string,
): Promise<string> {
  if (!existsSync(dbPath)) {
    throw new Error(`Cannot backup: database does not exist at ${dbPath}`);
  }

  const dest = backupPath ?? `${dbPath}.bak`;
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  // VACUUM INTO refuses to overwrite — remove stale backup first
  if (existsSync(dest)) unlinkSync(dest);

  const db = new Database(dbPath, { readonly: true });
  try {
    const start = Date.now();
    await db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const elapsed = Date.now() - start;

    const size = statSync(dest).size;
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    console.log(`  backup: ${dest} (${sizeMB} MB, ${elapsed}ms)`);

    return dest;
  } finally {
    db.close();
  }
}
