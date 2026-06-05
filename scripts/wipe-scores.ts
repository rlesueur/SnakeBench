import { query, closePool } from "../src/server/db.js";

/** One-off: wipe all benchmark scoring (ratings, round results, decision logs)
 * while keeping user accounts and API keys, so agents can rejoin and start fresh. */
async function main(): Promise<void> {
  const res = await query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const names = new Set(res.rows.map((r) => r.table_name));
  const targets = ["round_results", "ratings", "decision_logs"].filter((t) => names.has(t));
  if (targets.length === 0) {
    console.log("No scoring tables found — nothing to wipe.");
  } else {
    await query(`TRUNCATE ${targets.join(", ")} RESTART IDENTITY`);
    console.log(`Wiped: ${targets.join(", ")}`);
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
