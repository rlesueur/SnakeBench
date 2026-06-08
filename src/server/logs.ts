import { query } from "./db.js";
import { userIdByDisplayName } from "./users.js";

export interface DecisionLog {
  ts: number;
  round: number;
  tick: number;
  account: string;
  snakeId: string;
  move: string;
  /** The agent's declared intent (validated enum), or null if undeclared. */
  intent?: string | null;
  /** The agent's optional sanitised free-text target. */
  target?: string | null;
  /** Server-measured time between sending state and receiving the action. */
  latencyMs: number | null;
  /** The vision-scoped state the decision was based on (as sent to the agent). */
  view: unknown;
  /** Free-form evidence supplied by the agent (reasoning, prompt, model, etc.). */
  evidence: unknown;
}

/** Keep at most this many decision rows per account (one row per tick played). */
const RETENTION = Number(process.env.LOG_RETENTION) || 1000;

/**
 * Per-account decision logs persisted in Postgres. Appends are fire-and-forget
 * from the tick path; reads/deletes are async and used only by the HTTP API.
 */
export class LogStore {
  /** Per-account append counter, used to prune occasionally rather than every row. */
  private readonly sincePrune = new Map<string, number>();

  append(entry: DecisionLog): void {
    void this.insert(entry);
  }

  private async insert(entry: DecisionLog): Promise<void> {
    try {
      const userId = await userIdByDisplayName(entry.account);
      await query(
        `INSERT INTO decision_logs (user_id, display_name, round, tick, move, intent, target, latency_ms, view, evidence, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))`,
        [
          userId,
          entry.account,
          entry.round,
          entry.tick,
          entry.move,
          entry.intent ?? null,
          entry.target ?? null,
          entry.latencyMs,
          entry.view === null ? null : JSON.stringify(entry.view),
          entry.evidence === null ? null : JSON.stringify(entry.evidence),
          entry.ts,
        ],
      );
      const n = (this.sincePrune.get(entry.account) ?? 0) + 1;
      if (n >= 200) {
        this.sincePrune.set(entry.account, 0);
        await this.prune(entry.account);
      } else {
        this.sincePrune.set(entry.account, n);
      }
    } catch (err) {
      console.error("Failed to write decision log:", (err as Error).message);
    }
  }

  private async prune(account: string): Promise<void> {
    await query(
      `DELETE FROM decision_logs
       WHERE display_name = $1
         AND id NOT IN (
           SELECT id FROM decision_logs WHERE display_name = $1 ORDER BY ts DESC LIMIT $2
         )`,
      [account, RETENTION],
    );
  }

  /** Most recent entries first. */
  async read(account: string, limit = 200): Promise<DecisionLog[]> {
    const r = await query<{
      ts: string;
      round: number;
      tick: number;
      display_name: string;
      move: string;
      intent: string | null;
      target: string | null;
      latency_ms: number | null;
      view: unknown;
      evidence: unknown;
    }>(
      `SELECT extract(epoch FROM ts) * 1000 AS ts, round, tick, display_name, move,
              intent, target, latency_ms, view, evidence
       FROM decision_logs WHERE display_name = $1 ORDER BY ts DESC LIMIT $2`,
      [account, limit],
    );
    return r.rows.map((row) => ({
      ts: Number(row.ts),
      round: row.round,
      tick: row.tick,
      account: row.display_name,
      snakeId: "",
      move: row.move,
      intent: row.intent,
      target: row.target,
      latencyMs: row.latency_ms,
      view: row.view,
      evidence: row.evidence,
    }));
  }

  async count(account: string): Promise<number> {
    const r = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM decision_logs WHERE display_name = $1",
      [account],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async clear(account: string): Promise<boolean> {
    const r = await query("DELETE FROM decision_logs WHERE display_name = $1", [account]);
    return (r.rowCount ?? 0) > 0;
  }
}
