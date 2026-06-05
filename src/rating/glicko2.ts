/**
 * Glicko-2 rating system (Mark Glickman), implemented from scratch — no
 * dependencies. Each competitor has a rating, a rating deviation (RD, the
 * uncertainty), and a volatility. A round of SnakeBench is a free-for-all, so
 * the arena expands each round's final standings into pairwise results
 * (see expandStandings) and feeds them here as one rating period per player.
 *
 * Reference: http://www.glicko.net/glicko/glicko2.pdf
 */

export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

export interface GameResult {
  /** Opponent's rating and RD at the time of the round. */
  rating: number;
  rd: number;
  /** Score against this opponent: 1 win, 0.5 draw, 0 loss. */
  score: number;
  /**
   * Relative information weight of this result (default 1). A free-for-all round
   * is expanded into many *correlated* pairwise results (finish 1st and you
   * "beat" everyone at once), which violates Glicko-2's assumption that games in
   * a period are independent. Down-weighting each pairwise result so a whole
   * round sums to ~1 keeps one round worth roughly one game, instead of letting
   * RD collapse after a single match.
   */
  weight?: number;
}

/** Glicko-2 defaults. */
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;
export const DEFAULT_VOL = 0.06;
/** System constant: smaller = ratings change more conservatively over time. */
export const TAU = 0.5;
/** Convergence tolerance for the volatility iteration. */
const EPSILON = 0.000001;
/** Glicko-2 internal scale factor (ratings <-> mu/phi). */
const SCALE = 173.7178;

/** A leaderboard is provisional until it has enough games and low uncertainty. */
export const MIN_GAMES = 5;
export const PROVISIONAL_RD = 100;

export function createRating(
  rating = DEFAULT_RATING,
  rd = DEFAULT_RD,
  vol = DEFAULT_VOL,
): Rating {
  return { rating, rd, vol };
}

/** Conservative skill estimate used for ranking (TrueSkill-style: low end of
 * the confidence interval, so uncertain players are not over-ranked). */
export function conservative(r: Rating): number {
  return r.rating - 2 * r.rd;
}

export function isProvisional(r: Rating, games: number): boolean {
  return games < MIN_GAMES || r.rd > PROVISIONAL_RD;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Apply one Glicko-2 rating period. `results` are this player's outcomes
 * against each opponent. With no results the rating is unchanged but the RD
 * grows (handled by callers; we just return the input here).
 */
export function updateRating(player: Rating, results: GameResult[]): Rating {
  if (results.length === 0) {
    // No games: only uncertainty grows (step 6 with v -> infinity).
    const phi = player.rd / SCALE;
    const phiStar = Math.sqrt(phi * phi + player.vol * player.vol);
    return { rating: player.rating, rd: Math.min(phiStar * SCALE, DEFAULT_RD), vol: player.vol };
  }

  const mu = (player.rating - DEFAULT_RATING) / SCALE;
  const phi = player.rd / SCALE;

  // Step 3: estimated variance v.
  let vInv = 0;
  // Step 4: estimated improvement delta (numerator term).
  let deltaSum = 0;
  for (const r of results) {
    const w = r.weight ?? 1;
    const muJ = (r.rating - DEFAULT_RATING) / SCALE;
    const phiJ = r.rd / SCALE;
    const gj = g(phiJ);
    const e = expectedScore(mu, muJ, phiJ);
    vInv += w * gj * gj * e * (1 - e);
    deltaSum += w * gj * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility via the Illinois (regula falsi) algorithm.
  const a = Math.log(player.vol * player.vol);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k += 1;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  // Step 6-7: new RD and rating.
  const phiStar = Math.sqrt(phi * phi + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  return {
    rating: SCALE * newMu + DEFAULT_RATING,
    rd: SCALE * newPhi,
    vol: newVol,
  };
}

/**
 * Expand a free-for-all round's final standings (rank 1 = best) into per-player
 * pairwise GameResults: each player is scored 1/0.5/0 against every other
 * participant by rank. Each pairwise result is weighted by 1/(N-1) so the whole
 * round contributes roughly one game's worth of information (the pairwise
 * outcomes are highly correlated, so treating them as N-1 independent games
 * would make ratings converge far too fast). Returns a map of
 * competitorId -> results.
 */
export function expandStandings(
  field: Array<{ id: string; rank: number; rating: number; rd: number }>,
): Map<string, GameResult[]> {
  const out = new Map<string, GameResult[]>();
  const weight = field.length > 1 ? 1 / (field.length - 1) : 1;
  for (const me of field) {
    const results: GameResult[] = [];
    for (const opp of field) {
      if (opp.id === me.id) continue;
      const score = me.rank < opp.rank ? 1 : me.rank > opp.rank ? 0 : 0.5;
      results.push({ rating: opp.rating, rd: opp.rd, score, weight });
    }
    out.set(me.id, results);
  }
  return out;
}
