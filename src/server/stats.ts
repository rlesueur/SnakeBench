import { query } from "./db.js";
import { userIdByDisplayName } from "./users.js";
import { SPACE_CAP } from "../engine/decision-quality.js";
import {
  type Rating,
  type GameResult,
  createRating,
  updateRating,
  conservative,
  isProvisional,
} from "../rating/glicko2.js";

/** Per-round decision-quality metrics for one agent (server-authoritative). */
export interface RoundQuality {
  moves: number;
  legalRate: number;
  safeRate: number;
  /** 0 or 1 — whether the round ended in an avoidable death. */
  avoidableDeath: number;
  avgSpace: number;
  foodPerTick: number;
  timeoutRate: number;
  survivalTicks: number;
  /** Mean server-measured decision latency (ms) over the round, 0 if unknown. */
  latencyMs: number;
  /** Moves made this round while a law was in force. */
  lawMoves: number;
  /** Law-aware safe-rate over those law-round moves (0..1) — the agent's
   * law-comprehension. null when this round had no laws (nothing to measure). */
  lawComprehension: number | null;
}

export interface RoundEntry {
  account: string;
  rank: number;
  peakSize: number;
  fieldSize: number;
  quality: RoundQuality;
  /** Pairwise Glicko-2 results for this agent vs the rest of the field. */
  ratingResults: GameResult[];
}

interface AccountStat {
  account: string;
  gamesPlayed: number;
  wins: number;
  maxSize: number;
  totalSize: number;
  lastRound: number;
  updatedAt: number;
  rating: Rating;
  // Running averages of per-round quality (denominator = qGames).
  qGames: number;
  legalRate: number;
  safeRate: number;
  avoidableRate: number;
  spaceAvg: number;
  foodRate: number;
  timeoutRate: number;
  survivalAvg: number;
  placementAvg: number;
  latencyAvg: number;
  // Law comprehension, averaged over law rounds only (lawGames is the denominator).
  lawGames: number;
  lawComprehension: number;
}

/** Decision-quality composite weights (documented; sum to 1.0). */
const W_SAFE = 0.3;
const W_AVOID = 0.25;
const W_SPACE = 0.2;
const W_FOOD = 0.15;
const W_TIMEOUT = 0.1;
/** Growth-per-tick that maps to a perfect food-efficiency sub-score. */
const FOOD_NORM = 0.3;

/** Max number of missed rounds we'll age a returning player's RD by, so a long
 * absence inflates uncertainty (rating decay) without unbounded work. */
const MAX_IDLE_PERIODS = 15;

/** Composite 0-100 decision-quality score for a single round's metrics. Uses
 * the same weights as the all-time average so a per-round figure is directly
 * comparable. Exposed so the arena can return it to the agent each round. */
export function roundDecisionQuality(q: RoundQuality): number {
  const spaceNorm = Math.min(1, q.avgSpace / SPACE_CAP);
  const foodEff = Math.min(1, q.foodPerTick / FOOD_NORM);
  const blend =
    W_SAFE * q.safeRate +
    W_AVOID * (1 - q.avoidableDeath) +
    W_SPACE * spaceNorm +
    W_FOOD * foodEff +
    W_TIMEOUT * (1 - q.timeoutRate);
  return Math.round(100 * blend * q.legalRate);
}

export interface LeaderRow {
  account: string;
  gamesPlayed: number;
  wins: number;
  maxSize: number;
  avgSize: number;
  // Outcome skill.
  rating: number;
  rd: number;
  conservativeRating: number;
  provisional: boolean;
  winRate: number;
  avgPlacement: number;
  // Decision quality (process).
  decisionQuality: number | null;
  safeRate: number;
  avoidableRate: number;
  spaceAvg: number;
  foodRate: number;
  timeoutRate: number;
  survivalAvg: number;
  latencyMs: number;
  /** Law-comprehension rate (0..1) averaged over law rounds, or null if the
   * account has not yet played a round with a law. */
  lawComprehension: number | null;
}

/**
 * Cross-round benchmark stats, persisted in Postgres and aggregated in memory
 * so leaderboard() stays synchronous and the game tick is never blocked on the
 * database. Tracks two distinct, volume-proof scores: an opponent-aware
 * Glicko-2 rating (outcome) and a decision-quality composite (process).
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
      q_games: string;
      legal_rate: string | null;
      safe_rate: string | null;
      avoidable_rate: string | null;
      space_avg: string | null;
      food_rate: string | null;
      timeout_rate: string | null;
      survival_avg: string | null;
      placement_avg: string | null;
      latency_avg: string | null;
      law_games: string | null;
      law_rate: string | null;
    }>(
      `SELECT display_name,
              count(*)                                  AS games,
              sum(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
              max(peak_size)                            AS max_size,
              sum(peak_size)                            AS total_size,
              max(round)                                AS last_round,
              extract(epoch FROM max(ended_at)) * 1000  AS updated_at,
              count(q_safe_rate)                        AS q_games,
              avg(q_legal_rate)                         AS legal_rate,
              avg(q_safe_rate)                          AS safe_rate,
              avg(q_avoidable)                          AS avoidable_rate,
              avg(q_space)                              AS space_avg,
              avg(q_food_rate)                          AS food_rate,
              avg(q_timeout_rate)                       AS timeout_rate,
              avg(survival_ticks)                       AS survival_avg,
              avg(q_latency_ms)                         AS latency_avg,
              count(q_law_rate)                         AS law_games,
              avg(q_law_rate)                           AS law_rate,
              avg((field_size - rank)::float / NULLIF(field_size - 1, 0)) AS placement_avg
       FROM round_results
       GROUP BY display_name`,
    );

    const ratings = await query<{
      display_name: string;
      rating: string;
      rd: string;
      vol: string;
    }>(`SELECT display_name, rating, rd, vol FROM ratings`);
    const ratingByName = new Map<string, Rating>();
    for (const row of ratings.rows) {
      ratingByName.set(row.display_name, {
        rating: Number(row.rating),
        rd: Number(row.rd),
        vol: Number(row.vol),
      });
    }

    this.data.clear();
    for (const row of r.rows) {
      const num = (v: string | null): number => (v == null ? 0 : Number(v));
      this.data.set(row.display_name, {
        account: row.display_name,
        gamesPlayed: Number(row.games),
        wins: Number(row.wins),
        maxSize: Number(row.max_size),
        totalSize: Number(row.total_size),
        lastRound: Number(row.last_round),
        updatedAt: Number(row.updated_at),
        rating: ratingByName.get(row.display_name) ?? createRating(),
        qGames: Number(row.q_games),
        legalRate: num(row.legal_rate),
        safeRate: num(row.safe_rate),
        avoidableRate: num(row.avoidable_rate),
        spaceAvg: num(row.space_avg),
        foodRate: num(row.food_rate),
        timeoutRate: num(row.timeout_rate),
        survivalAvg: num(row.survival_avg),
        placementAvg: num(row.placement_avg),
        latencyAvg: num(row.latency_avg),
        lawGames: Number(row.law_games ?? 0),
        lawComprehension: num(row.law_rate),
      });
    }
  }

  /** Current rating for an account (default if unseen). Used by the arena to
   * build the opponent field before a round's results are applied. */
  getRating(account: string): Rating {
    return this.data.get(account)?.rating ?? createRating();
  }

  private ensure(account: string): AccountStat {
    let s = this.data.get(account);
    if (!s) {
      s = {
        account,
        gamesPlayed: 0,
        wins: 0,
        maxSize: 0,
        totalSize: 0,
        lastRound: 0,
        updatedAt: 0,
        rating: createRating(),
        qGames: 0,
        legalRate: 0,
        safeRate: 0,
        avoidableRate: 0,
        spaceAvg: 0,
        foodRate: 0,
        timeoutRate: 0,
        survivalAvg: 0,
        placementAvg: 0,
        latencyAvg: 0,
        lawGames: 0,
        lawComprehension: 0,
      };
      this.data.set(account, s);
    }
    return s;
  }

  /** Apply one finished round's results. Updates the cache synchronously and
   * persists to Postgres in the background (never blocks the tick loop). */
  recordRound(round: number, entries: RoundEntry[]): void {
    if (entries.length === 0) return;
    for (const e of entries) {
      const s = this.ensure(e.account);
      const prevRound = s.lastRound;
      s.gamesPlayed += 1;
      if (e.rank === 1) s.wins += 1;
      s.maxSize = Math.max(s.maxSize, e.peakSize);
      s.totalSize += e.peakSize;
      s.lastRound = round;
      s.updatedAt = Date.now();

      // Rating decay: age the rating by the rounds this account sat out since it
      // last played, so a long absence raises uncertainty (RD) before the new
      // result is applied. Each empty Glicko period grows RD toward the default.
      const idle = prevRound > 0 ? Math.min(MAX_IDLE_PERIODS, round - prevRound - 1) : 0;
      for (let i = 0; i < idle; i++) s.rating = updateRating(s.rating, []);

      // Opponent-aware rating update from the round's pairwise results.
      s.rating = updateRating(s.rating, e.ratingResults);

      // Running averages of decision-quality (volume-proof).
      const n = s.qGames;
      const placement = e.fieldSize > 1 ? (e.fieldSize - e.rank) / (e.fieldSize - 1) : 1;
      const avg = (old: number, val: number): number => (old * n + val) / (n + 1);
      s.legalRate = avg(s.legalRate, e.quality.legalRate);
      s.safeRate = avg(s.safeRate, e.quality.safeRate);
      s.avoidableRate = avg(s.avoidableRate, e.quality.avoidableDeath);
      s.spaceAvg = avg(s.spaceAvg, e.quality.avgSpace);
      s.foodRate = avg(s.foodRate, e.quality.foodPerTick);
      s.timeoutRate = avg(s.timeoutRate, e.quality.timeoutRate);
      s.survivalAvg = avg(s.survivalAvg, e.quality.survivalTicks);
      s.placementAvg = avg(s.placementAvg, placement);
      s.latencyAvg = avg(s.latencyAvg, e.quality.latencyMs);
      s.qGames = n + 1;

      // Law comprehension is averaged only over rounds that actually had a law.
      if (e.quality.lawComprehension != null) {
        s.lawComprehension = (s.lawComprehension * s.lawGames + e.quality.lawComprehension) / (s.lawGames + 1);
        s.lawGames += 1;
      }
    }
    void this.persist(round, entries);
  }

  private async persist(round: number, entries: RoundEntry[]): Promise<void> {
    try {
      for (const e of entries) {
        const userId = await userIdByDisplayName(e.account);
        await query(
           `INSERT INTO round_results
             (round, user_id, display_name, rank, peak_size, field_size, survival_ticks,
              q_moves, q_legal_rate, q_safe_rate, q_avoidable, q_space, q_food_rate, q_timeout_rate,
              q_latency_ms, q_law_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            round,
            userId,
            e.account,
            e.rank,
            e.peakSize,
            e.fieldSize,
            e.quality.survivalTicks,
            e.quality.moves,
            e.quality.legalRate,
            e.quality.safeRate,
            e.quality.avoidableDeath,
            e.quality.avgSpace,
            e.quality.foodPerTick,
            e.quality.timeoutRate,
            e.quality.latencyMs,
            e.quality.lawComprehension,
          ],
        );
        const s = this.data.get(e.account)!;
        await query(
          `INSERT INTO ratings (display_name, user_id, rating, rd, vol, games, last_round, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (display_name) DO UPDATE
             SET user_id = EXCLUDED.user_id, rating = EXCLUDED.rating, rd = EXCLUDED.rd,
                 vol = EXCLUDED.vol, games = EXCLUDED.games, last_round = EXCLUDED.last_round,
                 updated_at = now()`,
          [e.account, userId, s.rating.rating, s.rating.rd, s.rating.vol, s.gamesPlayed, round],
        );
      }
    } catch (err) {
      console.error("Failed to persist round results:", (err as Error).message);
    }
  }

  /** Composite 0-100 decision-quality score, or null if no quality data yet. */
  private decisionQuality(s: AccountStat): number | null {
    if (s.qGames === 0) return null;
    const spaceNorm = Math.min(1, s.spaceAvg / SPACE_CAP);
    const foodEff = Math.min(1, s.foodRate / FOOD_NORM);
    const blend =
      W_SAFE * s.safeRate +
      W_AVOID * (1 - s.avoidableRate) +
      W_SPACE * spaceNorm +
      W_FOOD * foodEff +
      W_TIMEOUT * (1 - s.timeoutRate);
    return Math.round(100 * blend * s.legalRate);
  }

  private toRow(s: AccountStat): LeaderRow {
    return {
      account: s.account,
      gamesPlayed: s.gamesPlayed,
      wins: s.wins,
      maxSize: s.maxSize,
      avgSize: s.gamesPlayed ? s.totalSize / s.gamesPlayed : 0,
      rating: s.rating.rating,
      rd: s.rating.rd,
      conservativeRating: conservative(s.rating),
      provisional: isProvisional(s.rating, s.gamesPlayed),
      winRate: s.gamesPlayed ? s.wins / s.gamesPlayed : 0,
      avgPlacement: s.placementAvg,
      decisionQuality: this.decisionQuality(s),
      safeRate: s.safeRate,
      avoidableRate: s.avoidableRate,
      spaceAvg: s.spaceAvg,
      foodRate: s.foodRate,
      timeoutRate: s.timeoutRate,
      survivalAvg: s.survivalAvg,
      latencyMs: s.latencyAvg,
      lawComprehension: s.lawGames ? s.lawComprehension : null,
    };
  }

  /**
   * Leaderboard ranked by skill, not volume: established players (non-provisional)
   * first, ordered by conservative rating, then decision quality. Provisional
   * players follow, ranked the same way.
   */
  leaderboard(limit = 50): LeaderRow[] {
    return [...this.data.values()]
      .map((s) => this.toRow(s))
      .sort(
        (a, b) =>
          Number(a.provisional) - Number(b.provisional) ||
          b.conservativeRating - a.conservativeRating ||
          (b.decisionQuality ?? -1) - (a.decisionQuality ?? -1),
      )
      .slice(0, limit);
  }

  /** Look up a single account's row (for the account dashboard). */
  rowFor(account: string): LeaderRow | null {
    const s = this.data.get(account);
    return s ? this.toRow(s) : null;
  }
}
