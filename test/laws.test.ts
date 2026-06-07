import { describe, expect, it } from "vitest";
import { Game } from "../src/engine/game.js";
import type { GameConfig } from "../src/config.js";
import {
  applyTransform,
  constraintViolation,
  lethalFoodValue,
  obstaclesPassable,
  LAW_BUILDERS,
  type Law,
} from "../src/engine/laws.js";
import { rollLaws } from "../src/rules/cards.js";
import { cellKey, type Cell, type Direction } from "../src/types.js";

function cfg(over: Partial<GameConfig> = {}): GameConfig {
  return {
    width: 12,
    height: 12,
    tickDeadlineMs: 2000,
    foodTarget: 0,
    foodTypes: [{ value: 1, weight: 1 }],
    carcassFoodValue: 2,
    obstacleDensity: 0,
    foodGrows: true,
    absorbFraction: 0.5,
    cutoffAbsorbFraction: 0,
    headToHead: "longest",
    comboWindowTicks: 4,
    comboMaxBonus: 4,
    lengthTaxTicks: 0,
    visionRadius: 5,
    startingLength: 3,
    maxTicks: 100,
    ...over,
  };
}

function single(config: GameConfig): Game {
  return Game.create([{ id: "s1", displayName: "s1", isNpc: false }], "seed", config);
}

function setBody(game: Game, heading: Direction, body: Cell[]): void {
  const s = game.snakeById("s1")!;
  s.heading = heading;
  s.body = body.map((c) => ({ ...c }));
}

describe("law helpers (pure)", () => {
  it("rotate transforms compose clockwise", () => {
    expect(applyTransform("up", [LAW_BUILDERS.rotate(1)])).toBe("right");
    expect(applyTransform("up", [LAW_BUILDERS.rotate(2)])).toBe("down");
    expect(applyTransform("up", [LAW_BUILDERS.rotate(3)])).toBe("left");
    expect(applyTransform("right", [LAW_BUILDERS.rotate(1)])).toBe("down");
  });

  it("mirror swaps a single axis", () => {
    expect(applyTransform("left", [LAW_BUILDERS.mirror("horizontal")])).toBe("right");
    expect(applyTransform("up", [LAW_BUILDERS.mirror("horizontal")])).toBe("up");
    expect(applyTransform("up", [LAW_BUILDERS.mirror("vertical")])).toBe("down");
    expect(applyTransform("left", [LAW_BUILDERS.mirror("vertical")])).toBe("left");
  });

  it("no_turn flags only the banned turn", () => {
    const law = LAW_BUILDERS.noTurn("left");
    const base = { prevHead: { x: 5, y: 5 }, tick: 1 };
    // heading right, then turning to up is a LEFT turn -> banned.
    expect(constraintViolation([law], { ...base, prevHeading: "right", heading: "up", newHead: { x: 5, y: 4 } })).toBe(law);
    // turning to down (a right turn) and going straight are both legal.
    expect(constraintViolation([law], { ...base, prevHeading: "right", heading: "down", newHead: { x: 5, y: 6 } })).toBeNull();
    expect(constraintViolation([law], { ...base, prevHeading: "right", heading: "right", newHead: { x: 6, y: 5 } })).toBeNull();
  });

  it("inversion flips obstacle/food lethality flags", () => {
    const laws = [LAW_BUILDERS.inversion(6)];
    expect(obstaclesPassable(laws)).toBe(true);
    expect(lethalFoodValue(laws)).toBe(6);
    expect(obstaclesPassable([])).toBe(false);
    expect(lethalFoodValue([])).toBeNull();
  });
});

describe("transform laws in the engine", () => {
  it("rotate remaps the submitted direction before moving", () => {
    const game = single(cfg({ laws: [LAW_BUILDERS.rotate(1)] }));
    // heading down; submit "up" -> rotate 90° CW -> right -> head moves east.
    setBody(game, "down", [
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
    ]);
    game.step(new Map([["s1", "up"]]));
    expect(game.snakeById("s1")!.body[0]).toEqual({ x: 6, y: 5 });
  });

  it("mirror swaps left/right before moving", () => {
    const game = single(cfg({ laws: [LAW_BUILDERS.mirror("horizontal")] }));
    setBody(game, "up", [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 7 },
    ]);
    game.step(new Map([["s1", "left"]])); // mirrored -> right
    expect(game.snakeById("s1")!.body[0]).toEqual({ x: 6, y: 5 });
  });
});

describe("constraint laws in the engine", () => {
  it("no_turn kills on the banned turn but allows the other", () => {
    const banned = single(cfg({ laws: [LAW_BUILDERS.noTurn("left")] }));
    setBody(banned, "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    const events = banned.step(new Map([["s1", "up"]])); // left turn -> unlawful
    expect(banned.snakeById("s1")!.alive).toBe(false);
    expect(events.some((e) => e.kind === "death" && e.cause === "unlawful")).toBe(true);

    const ok = single(cfg({ laws: [LAW_BUILDERS.noTurn("left")] }));
    setBody(ok, "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    ok.step(new Map([["s1", "down"]])); // right turn -> legal
    expect(ok.snakeById("s1")!.alive).toBe(true);
  });

  it("cadence kills a snake that fails to close on the beacon tick", () => {
    // anchor to the north; every 2nd tick must move strictly closer.
    const game = single(cfg({ laws: [LAW_BUILDERS.cadence(2, { x: 5, y: 0 })] }));
    setBody(game, "up", [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 7 },
    ]);
    game.step(new Map([["s1", "up"]])); // tick 0 (free)
    game.step(new Map([["s1", "up"]])); // tick 1 (free)
    // tick 2 (cadence): turning aside does not reduce distance -> unlawful.
    const events = game.step(new Map([["s1", "left"]]));
    expect(game.snakeById("s1")!.alive).toBe(false);
    expect(events.some((e) => e.kind === "death" && e.cause === "unlawful")).toBe(true);
  });

  it("cadence spares a snake that moves toward the beacon on its tick", () => {
    const game = single(cfg({ laws: [LAW_BUILDERS.cadence(2, { x: 5, y: 0 })] }));
    setBody(game, "up", [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 7 },
    ]);
    game.step(new Map([["s1", "up"]])); // tick 0
    game.step(new Map([["s1", "up"]])); // tick 1
    game.step(new Map([["s1", "up"]])); // tick 2 (cadence) — straight on closes distance
    expect(game.snakeById("s1")!.alive).toBe(true);
  });
});

describe("semantic law (inversion) in the engine", () => {
  it("lets a snake pass harmlessly through an obstacle", () => {
    const game = single(cfg({ laws: [LAW_BUILDERS.inversion(6)] }));
    setBody(game, "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.obstacles.add(cellKey({ x: 6, y: 5 }));
    game.step(new Map([["s1", "right"]]));
    const s = game.snakeById("s1")!;
    expect(s.alive).toBe(true);
    expect(s.body[0]).toEqual({ x: 6, y: 5 });
  });

  it("kills a snake that eats large (now-lethal) food", () => {
    const game = single(cfg({ laws: [LAW_BUILDERS.inversion(6)] }));
    setBody(game, "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.food.set(cellKey({ x: 6, y: 5 }), 6); // big food -> lethal under inversion
    game.step(new Map([["s1", "right"]]));
    expect(game.snakeById("s1")!.alive).toBe(false);

    // Small food on the same flip is still safe.
    const safe = single(cfg({ laws: [LAW_BUILDERS.inversion(6)] }));
    setBody(safe, "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    safe.food.set(cellKey({ x: 6, y: 5 }), 1);
    safe.step(new Map([["s1", "right"]]));
    expect(safe.snakeById("s1")!.alive).toBe(true);
  });
});

describe("a law-ignoring greedy move fails where a law-aware one survives", () => {
  it("under reversed controls, the naive direction goes the wrong way", () => {
    // Food sits to the east. A greedy snake submits "right" to chase it, but
    // rotate(2) reverses the move and sends it west; a law-aware snake submits
    // "left" and actually reaches the food.
    const greedy = single(cfg({ laws: [LAW_BUILDERS.rotate(2)] }));
    setBody(greedy, "up", [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 7 },
    ]);
    greedy.food.set(cellKey({ x: 6, y: 5 }), 1);
    greedy.step(new Map([["s1", "right"]]));
    expect(greedy.snakeById("s1")!.body[0]).toEqual({ x: 4, y: 5 }); // sent west, missed food

    const aware = single(cfg({ laws: [LAW_BUILDERS.rotate(2)] }));
    setBody(aware, "up", [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 7 },
    ]);
    aware.food.set(cellKey({ x: 6, y: 5 }), 1);
    aware.step(new Map([["s1", "left"]]));
    const s = aware.snakeById("s1")!;
    expect(s.body[0]).toEqual({ x: 6, y: 5 }); // inverted move reached the food
    expect(s.body.length).toBeGreaterThan(3); // and grew
  });
});

describe("rollLaws", () => {
  it("is deterministic for a seed and stays within one law per category", () => {
    const a = rollLaws("r1", 80, 80);
    const b = rollLaws("r1", 80, 80);
    expect(a).toEqual(b);
    for (const laws of [rollLaws("r2", 80, 80), rollLaws("r3", 80, 80), rollLaws("r4", 80, 80)]) {
      expect(laws.length).toBeLessThanOrEqual(2);
      const cats = new Set(laws.map((l: Law) => l.category));
      expect(cats.size).toBe(laws.length); // no two laws share a category
    }
  });
});
