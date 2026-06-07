import { describe, expect, it } from "vitest";
import { analyseMove, reachableSpace, type MoveContext } from "../src/engine/decision-quality.js";
import { LAW_BUILDERS } from "../src/engine/laws.js";
import type { Direction } from "../src/types.js";

function ctx(over: Partial<MoveContext> = {}): MoveContext {
  return {
    width: 10,
    height: 10,
    obstacles: new Set<string>(),
    blocked: new Set<string>(),
    head: { x: 5, y: 5 },
    heading: "right" as Direction,
    submittedMove: "up" as Direction,
    ...over,
  };
}

describe("decision-quality analyser", () => {
  it("scores an open, legal move as safe", () => {
    const a = analyseMove(ctx({ submittedMove: "up" }));
    expect(a.legal).toBe(true);
    expect(a.timeout).toBe(false);
    expect(a.hadSafeAlternative).toBe(true);
    expect(a.choseSafe).toBe(true);
    expect(a.spaceAfter).toBeGreaterThan(0);
  });

  it("flags a timeout (no move submitted) and continues on heading", () => {
    const a = analyseMove(ctx({ submittedMove: null }));
    expect(a.timeout).toBe(true);
    expect(a.legal).toBe(false);
    // heading right is open, so continuing is still safe here.
    expect(a.choseSafe).toBe(true);
  });

  it("treats a reversal as illegal (engine continues on heading)", () => {
    // heading right, submit left (the reverse) -> illegal, continue right.
    const a = analyseMove(ctx({ heading: "right", submittedMove: "left" }));
    expect(a.legal).toBe(false);
  });

  it("detects choosing an unsafe move when a safe one existed", () => {
    // Wall directly to the right (the chosen move), but up/down are open.
    const blocked = new Set<string>(["6,5"]);
    const a = analyseMove(ctx({ heading: "right", submittedMove: "right", blocked }));
    expect(a.hadSafeAlternative).toBe(true);
    expect(a.choseSafe).toBe(false);
  });

  it("reports no safe alternative when all candidates are blocked", () => {
    // heading right (reverse=left); block up/down/right around the head.
    const blocked = new Set<string>(["5,4", "5,6", "6,5"]);
    const a = analyseMove(ctx({ head: { x: 5, y: 5 }, heading: "right", submittedMove: "up", blocked }));
    expect(a.hadSafeAlternative).toBe(false);
    expect(a.choseSafe).toBe(false);
  });

  it("treats out-of-bounds as unsafe", () => {
    // At the right edge, moving right leaves the board.
    const a = analyseMove(ctx({ head: { x: 9, y: 5 }, heading: "right", submittedMove: "right" }));
    expect(a.choseSafe).toBe(false);
  });

  it("treats obstacles as unsafe", () => {
    const obstacles = new Set<string>(["5,4"]);
    const a = analyseMove(ctx({ head: { x: 5, y: 5 }, heading: "right", submittedMove: "up", obstacles }));
    expect(a.choseSafe).toBe(false);
  });

  it("treats a cell a longer enemy head could enter as unsafe (head-to-head)", () => {
    // We are length 4 at (5,5) heading right. A length-6 enemy head sits at
    // (5,3) heading down, so it threatens (5,4) — our 'up' move.
    const enemyHeads = [{ head: { x: 5, y: 3 }, heading: "down" as Direction, length: 6 }];
    const up = analyseMove(
      ctx({ heading: "right", submittedMove: "up", selfLength: 4, enemyHeads }),
    );
    // 'up' lands on a contested cell a longer snake could take -> not safe,
    // but down/right are still open, so a safe alternative existed.
    expect(up.choseSafe).toBe(false);
    expect(up.hadSafeAlternative).toBe(true);
  });

  it("ignores head-to-head danger from strictly shorter enemies", () => {
    // Same geometry, but the enemy is shorter (length 2 < our 4): we would win
    // the head-to-head, so moving 'up' is still considered safe.
    const enemyHeads = [{ head: { x: 5, y: 3 }, heading: "down" as Direction, length: 2 }];
    const up = analyseMove(
      ctx({ heading: "right", submittedMove: "up", selfLength: 4, enemyHeads }),
    );
    expect(up.choseSafe).toBe(true);
  });

  // The scorer must judge a move where the engine will actually resolve it once
  // a law changes the dynamics — otherwise the benchmark can't tell whether an
  // agent understood the round's prose. Each case shows the SAME submitted move
  // flipping verdict because of the law, and a law-aware alternative scoring safe.
  describe("is law-aware (the scoring discriminates reasoning from reflex)", () => {
    it("transform: a move judged safe by physics is unsafe once reversed controls send it into the wall", () => {
      // Head against the east wall, heading up (reverse = down).
      const base = { head: { x: 9, y: 5 }, heading: "right" as Direction, width: 10, height: 10 };
      // Lawless: submitting "up" steps to (9,4) — safe.
      expect(analyseMove(ctx({ ...base, submittedMove: "up" })).choseSafe).toBe(true);
      // Reversed controls: "down" is submitted, transformed to "up" → still (9,4);
      // but submitting "up" transforms to "down" → (9,6). Use a wall-bound case:
      const laws = [LAW_BUILDERS.rotate(2)];
      // Submitting "right" is coerced (transforms to its reverse "left") — but the
      // telling case: "up" transforms to "down" (safe) and "down" → "up" (safe);
      // put the danger to the east so a naive "stay off the wall" pick backfires.
      const edge = { head: { x: 9, y: 5 }, heading: "up" as Direction, width: 10, height: 10 };
      // Lawless, "left" → (8,5) safe.
      expect(analyseMove(ctx({ ...edge, submittedMove: "left" })).choseSafe).toBe(true);
      // Reversed: "left" → transformed "right" → (10,5) off-board → unsafe, but a
      // law-aware agent submits "right" → "left" → (8,5) safe.
      const blind = analyseMove(ctx({ ...edge, submittedMove: "left", laws }));
      expect(blind.choseSafe).toBe(false);
      expect(blind.hadSafeAlternative).toBe(true);
      expect(analyseMove(ctx({ ...edge, submittedMove: "right", laws })).choseSafe).toBe(true);
    });

    it("constraint: a turn that is safe normally becomes unsafe under a one-way-turn law", () => {
      const base = { head: { x: 5, y: 5 }, heading: "right" as Direction };
      // Lawless: turning up (a left turn) lands on the open cell (5,4) — safe.
      expect(analyseMove(ctx({ ...base, submittedMove: "up" })).choseSafe).toBe(true);
      // no_turn(left): the same "up" is a banned left turn → fatal → unsafe, but
      // straight-on / the right turn remain safe alternatives.
      const laws = [LAW_BUILDERS.noTurn("left")];
      const blind = analyseMove(ctx({ ...base, submittedMove: "up", laws }));
      expect(blind.choseSafe).toBe(false);
      expect(blind.hadSafeAlternative).toBe(true);
      expect(analyseMove(ctx({ ...base, submittedMove: "down", laws })).choseSafe).toBe(true);
    });

    it("constraint: a move is unsafe on a cadence tick unless it closes on the beacon", () => {
      // Anchor north at (5,0); on tick 2 (a multiple of 2) we must move closer.
      const base = { head: { x: 5, y: 5 }, heading: "up" as Direction };
      const laws = [LAW_BUILDERS.cadence(2, { x: 5, y: 0 })];
      // Turning aside (left) keeps the same distance → unlawful → unsafe.
      const aside = analyseMove(ctx({ ...base, submittedMove: "left", laws, tick: 2 }));
      expect(aside.choseSafe).toBe(false);
      expect(aside.hadSafeAlternative).toBe(true);
      // Heading straight up closes the distance → safe.
      expect(analyseMove(ctx({ ...base, submittedMove: "up", laws, tick: 2 })).choseSafe).toBe(true);
    });

    it("semantic: inversion makes obstacles passable and large food lethal", () => {
      const base = { head: { x: 5, y: 5 }, heading: "right" as Direction };
      const obstacle = { x: 5, y: 4 };
      const obstacles = new Set<string>([`${obstacle.x},${obstacle.y}`]);
      // Lawless: an obstacle to the north blocks "up".
      expect(analyseMove(ctx({ ...base, submittedMove: "up", obstacles })).choseSafe).toBe(false);
      // Inversion: that same obstacle is harmless to enter → "up" is now safe...
      const laws = [LAW_BUILDERS.inversion(6)];
      expect(analyseMove(ctx({ ...base, submittedMove: "up", obstacles, laws })).choseSafe).toBe(true);
      // ...but eating large food (≥6) is now fatal.
      const food = new Map<string, number>([["5,4", 6]]);
      const lethal = analyseMove(ctx({ ...base, submittedMove: "up", food, laws }));
      expect(lethal.choseSafe).toBe(false);
      expect(lethal.hadSafeAlternative).toBe(true);
    });
  });

  it("flood-fills only the reachable free pocket", () => {
    // 5x5 board with only (1,1) and (1,2) free; everything else blocked.
    const blocked = new Set<string>();
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        if ((x === 1 && y === 1) || (x === 1 && y === 2)) continue;
        blocked.add(`${x},${y}`);
      }
    }
    const space = reachableSpace({ x: 1, y: 1 }, ctx({ width: 5, height: 5, blocked }));
    expect(space).toBe(2);
  });
});
