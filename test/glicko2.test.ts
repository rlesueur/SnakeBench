import { describe, expect, it } from "vitest";
import {
  createRating,
  updateRating,
  conservative,
  isProvisional,
  expandStandings,
  DEFAULT_RATING,
  DEFAULT_RD,
} from "../src/rating/glicko2.js";

describe("glicko2", () => {
  it("matches Glickman's worked example", () => {
    // From the Glicko-2 paper: player 1500/200/0.06 vs three opponents.
    const player = createRating(1500, 200, 0.06);
    const result = updateRating(player, [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ]);
    // Paper results: rating ~1464.06, RD ~151.52, vol ~0.05999.
    expect(result.rating).toBeCloseTo(1464.06, 0);
    expect(result.rd).toBeCloseTo(151.52, 0);
    expect(result.vol).toBeCloseTo(0.05999, 3);
  });

  it("raises rating after a win and lowers it after a loss", () => {
    const base = createRating();
    const win = updateRating(base, [{ rating: 1500, rd: 200, score: 1 }]);
    const loss = updateRating(base, [{ rating: 1500, rd: 200, score: 0 }]);
    expect(win.rating).toBeGreaterThan(DEFAULT_RATING);
    expect(loss.rating).toBeLessThan(DEFAULT_RATING);
  });

  it("shrinks rating deviation as games are played", () => {
    let r = createRating();
    expect(r.rd).toBe(DEFAULT_RD);
    for (let i = 0; i < 10; i++) {
      r = updateRating(r, [{ rating: 1500, rd: 60, score: 0.5 }]);
    }
    expect(r.rd).toBeLessThan(DEFAULT_RD);
  });

  it("only grows uncertainty when there are no games", () => {
    const r = createRating(1700, 80, 0.06);
    const next = updateRating(r, []);
    expect(next.rating).toBe(1700);
    expect(next.rd).toBeGreaterThan(80);
  });

  it("conservative rating is below the point estimate", () => {
    const r = createRating(1600, 120, 0.06);
    expect(conservative(r)).toBe(1600 - 240);
  });

  it("flags provisional until enough games and low RD", () => {
    expect(isProvisional(createRating(1500, 350, 0.06), 0)).toBe(true);
    expect(isProvisional(createRating(1500, 80, 0.06), 2)).toBe(true); // too few games
    expect(isProvisional(createRating(1500, 80, 0.06), 10)).toBe(false);
  });

  it("expands free-for-all standings into pairwise win/loss/draw", () => {
    const field = [
      { id: "a", rank: 1, rating: 1500, rd: 200 },
      { id: "b", rank: 2, rating: 1500, rd: 200 },
      { id: "c", rank: 2, rating: 1500, rd: 200 },
    ];
    const out = expandStandings(field);
    // a beat both b and c.
    expect(out.get("a")!.map((r) => r.score).sort()).toEqual([1, 1]);
    // b: lost to a (0), drew c (0.5).
    expect(out.get("b")!.map((r) => r.score).sort()).toEqual([0, 0.5]);
  });

  it("weights expanded pairwise results so a round sums to ~one game", () => {
    const field = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      rank: i + 1,
      rating: 1500,
      rd: 200,
    }));
    const out = expandStandings(field);
    for (const results of out.values()) {
      const total = results.reduce((s, r) => s + (r.weight ?? 1), 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("weighting damps how fast RD collapses in a large free-for-all", () => {
    // Winning a big FFA via weighted pairwise results should move RD far less
    // than treating every pairwise result as an independent game.
    const base = createRating();
    const opponents = Array.from({ length: 12 }, () => ({ rating: 1500, rd: 200, score: 1 }));
    const unweighted = updateRating(base, opponents);
    const weighted = updateRating(
      base,
      opponents.map((o) => ({ ...o, weight: 1 / opponents.length })),
    );
    // Less information => RD stays higher (closer to the starting deviation).
    expect(weighted.rd).toBeGreaterThan(unweighted.rd);
    // And the rating moves less in a single round.
    expect(weighted.rating - DEFAULT_RATING).toBeLessThan(unweighted.rating - DEFAULT_RATING);
  });
});
