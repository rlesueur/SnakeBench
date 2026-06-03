import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { closePool, migrate, query } from "../src/server/db.js";

/**
 * One-off importer for the pre-Postgres file stores (data/accounts.json,
 * data/stats.json, data/logs/*.jsonl). Optional: the file data was throwaway
 * test data, but this lets you carry it over so old keys keep working.
 *
 * Run: npm run import-files
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function userIdForName(displayName: string, legacyKey?: string): Promise<string> {
  // Create (or fetch) a legacy user keyed by display name.
  await query(
    `INSERT INTO users (provider, subject, email, display_name)
     VALUES ('legacy', $1, NULL, $1)
     ON CONFLICT (provider, subject) DO NOTHING`,
    [displayName],
  );
  const r = await query<{ id: string }>(
    "SELECT id FROM users WHERE provider = 'legacy' AND subject = $1",
    [displayName],
  );
  const id = r.rows[0]!.id;
  if (legacyKey) {
    await query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
       VALUES ($1, $2, $3, 'imported')
       ON CONFLICT (key_hash) DO NOTHING`,
      [id, sha256(legacyKey), `${legacyKey.slice(0, 11)}...`],
    );
  }
  return id;
}

async function importAccounts(): Promise<void> {
  const file = resolve("data/accounts.json");
  if (!existsSync(file)) return;
  const accounts = JSON.parse(readFileSync(file, "utf8")) as Array<{ key: string; displayName: string }>;
  for (const a of accounts) await userIdForName(a.displayName, a.key);
  console.log(`Imported ${accounts.length} accounts.`);
}

async function importStats(): Promise<void> {
  const file = resolve("data/stats.json");
  if (!existsSync(file)) return;
  const stats = JSON.parse(readFileSync(file, "utf8")) as Array<{
    account: string; gamesPlayed: number; wins: number; maxSize: number; totalSize: number; lastRound: number;
  }>;
  for (const s of stats) {
    const userId = await userIdForName(s.account);
    // Reconstruct round_results that reproduce the aggregates: one row at the
    // peak (max) size, the remainder distributed across the other games.
    const others = Math.max(0, s.gamesPlayed - 1);
    const restEach = others > 0 ? Math.max(1, Math.round((s.totalSize - s.maxSize) / others)) : 0;
    for (let i = 0; i < s.gamesPlayed; i++) {
      const rank = i < s.wins ? 1 : 2;
      const peak = i === 0 ? s.maxSize : restEach;
      await query(
        `INSERT INTO round_results (round, user_id, display_name, rank, peak_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.lastRound, userId, s.account, rank, peak],
      );
    }
  }
  console.log(`Imported stats for ${stats.length} accounts.`);
}

async function importLogs(): Promise<void> {
  const dir = resolve("data/logs");
  if (!existsSync(dir)) return;
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const lines = readFileSync(resolve(dir, name), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e: {
        ts: number; round: number; tick: number; account: string; move: string;
        shed: boolean; latencyMs: number | null; view: unknown; evidence: unknown;
      };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const userId = await userIdForName(e.account);
      await query(
        `INSERT INTO decision_logs (user_id, display_name, round, tick, move, shed, latency_ms, view, evidence, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))`,
        [
          userId, e.account, e.round, e.tick, e.move, e.shed, e.latencyMs,
          e.view == null ? null : JSON.stringify(e.view),
          e.evidence == null ? null : JSON.stringify(e.evidence),
          e.ts,
        ],
      );
      total++;
    }
  }
  console.log(`Imported ${total} decision-log entries.`);
}

async function main(): Promise<void> {
  await migrate();
  await importAccounts();
  await importStats();
  await importLogs();
  await closePool();
  console.log("Import complete.");
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
