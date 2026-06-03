import { query } from "./db.js";
import { userIdByDisplayName } from "./users.js";

export interface AccountStat {
  account: string;
  gamesPlayed: number;
  wins: number;
  maxSize: number;
  /** Sum of peak sizes, for an average. */
  totalSize: number;
  lastRound: number;
  updatedAt: number;
}

export interface RoundEntry {
  account: string;
  rank: number;
  peakSize: number;
}

/**
 * Cross-round benchmark stats, persisted in Postgres (round_results) and
 * aggregated in memory so leaderboard() stays synchronous and the game tick is
 * never blocked on the database.
 */
export class StatsStore {
  private readonly data = new Map<string, AccountStat>();

  /** Load aggregates from Postgres into the in-memory leaderboard cache. */
  async init(): Promise<void> {
    const r = await query<{
      display_name: string;
      games: string;
      wins: string;
      max_size: string;
      total_size: string;
      last_round: string;
      updated_at: string;
    }>(
      `SELECT display_name,
              count(*)                                  AS games,
              sum(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
              max(peak_size)                            AS max_size,
              sum(peak_size)                            AS total_size,
              max(round)                                AS last_round,
              extract(epoch FROM max(ended_at)) * 1000  AS updated_at
       FROM round_results
       GROUP BY display_name`,
    );
    this.data.clear();
    for (const row of r.rows) {
      this.data.set(row.display_name, {
        account: row.display_name,
        gamesPlayed: Number(row.games),
        wins: Number(row.wins),
        maxSize: Number(row.max_size),
        totalSize: Number(row.total_size),
        lastRound: Number(row.last_round),
        updatedAt: Number(row.updated_at),
      });
    }
  }

  /** Apply one finished round's results. Updates the cache synchronously and
   * persists to Postgres in the background (never blocks the tick loop). */
  recordRound(round: number, entries: RoundEntry[]): void {
    if (entries.length === 0) return;
    for (const e of entries) {
      let s = this.data.get(e.account);
      if (!s) {
        s = { account: e.account, gamesPlayed: 0, wins: 0, maxSize: 0, totalSize: 0, lastRound: 0, updatedAt: 0 };
        this.data.set(e.account, s);
      }
      s.gamesPlayed += 1;
      if (e.rank === 1) s.wins += 1;
      s.maxSize = Math.max(s.maxSize, e.peakSize);
      s.totalSize += e.peakSize;
      s.lastRound = round;
      s.updatedAt = Date.now();
    }
    void this.persist(round, entries);
  }

  private async persist(round: number, entries: RoundEntry[]): Promise<void> {
    try {
      for (const e of entries) {
        const userId = await userIdByDisplayName(e.account);
        await query(
          `INSERT INTO round_results (round, user_id, display_name, rank, peak_size)
           VALUES ($1, $2, $3, $4, $5)`,
          [round, userId, e.account, e.rank, e.peakSize],
        );
      }
    } catch (err) {
      console.error("Failed to persist round results:", (err as Error).message);
    }
  }

  /** Leaderboard sorted by wins, then best size, then average size. */
  leaderboard(limit = 50): Array<AccountStat & { avgSize: number }> {
    return [...this.data.values()]
      .map((s) => ({ ...s, avgSize: s.gamesPlayed ? s.totalSize / s.gamesPlayed : 0 }))
      .sort((a, b) => b.wins - a.wins || b.maxSize - a.maxSize || b.avgSize - a.avgSize)
      .slice(0, limit);
  }
}
