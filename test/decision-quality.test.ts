import { describe, expect, it } from "vitest";
import { analyseMove, reachableSpace, type MoveContext } from "../src/engine/decision-quality.js";
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
