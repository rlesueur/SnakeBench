import { describe, expect, it } from "vitest";
import { Game } from "../src/engine/game.js";
import type { GameConfig } from "../src/config.js";
import { runMatch, type Participant } from "../src/match/runner.js";
import type { Cell, Direction } from "../src/types.js";

function cfg(over: Partial<GameConfig> = {}): GameConfig {
  return {
    width: 10,
    height: 10,
    tickDeadlineMs: 2000,
    foodTarget: 0,
    foodTypes: [{ value: 1, weight: 1 }],
    carcassFoodValue: 2,
    obstacleDensity: 0,
    absorbFraction: 0.5,
    comboWindowTicks: 4,
    comboMaxBonus: 4,
    powerUpTarget: 0,
    frenzyDurationTicks: 30,
    shedSegments: 3,
    shedMinLength: 3,
    visionRadius: 5,
    startingLength: 3,
    maxTicks: 100,
    ...over,
  };
}

function single(config: GameConfig): Game {
  return Game.create([{ id: "s1", displayName: "s1", isNpc: false }], "seed", config);
}

function setBody(game: Game, id: string, heading: Direction, body: Cell[]): void {
  const s = game.snakeById(id)!;
  s.heading = heading;
  s.body = body.map((c) => ({ ...c }));
}

describe("movement rules", () => {
  it("blocks reversing into the neck and keeps the current heading", () => {
    const game = single(cfg());
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.step(new Map([["s1", "left"]])); // illegal reverse
    expect(game.snakeById("s1")!.body[0]).toEqual({ x: 6, y: 5 });
  });

  it("kills a snake that runs into a wall", () => {
    const game = single(cfg());
    setBody(game, "s1", "right", [
      { x: 9, y: 5 },
      { x: 8, y: 5 },
      { x: 7, y: 5 },
    ]);
    game.step(new Map());
    expect(game.snakeById("s1")!.alive).toBe(false);
  });

  it("grows by one when eating a value-1 pellet", () => {
    const game = single(cfg());
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.food.set("6,5", 1);
    game.step(new Map());
    expect(game.snakeById("s1")!.body.length).toBe(4);
    expect(game.food.has("6,5")).toBe(false);
  });

  it("grows gradually over several ticks for high-value food", () => {
    const game = single(cfg({ width: 20 }));
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.food.set("6,5", 3); // value-3 fruit
    game.step(new Map()); // eat: +1 now, +2 owed
    expect(game.snakeById("s1")!.body.length).toBe(4);
    game.step(new Map());
    game.step(new Map());
    expect(game.snakeById("s1")!.body.length).toBe(6); // grew by 3 total
  });
});

describe("collisions", () => {
  it("resolves head-to-head in favour of the longer snake", () => {
    const game = Game.create(
      [
        { id: "long", displayName: "long", isNpc: false },
        { id: "short", displayName: "short", isNpc: false },
      ],
      "seed",
      cfg(),
    );
    setBody(game, "long", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
      { x: 2, y: 5 },
    ]);
    setBody(game, "short", "left", [
      { x: 7, y: 5 },
      { x: 8, y: 5 },
    ]);
    game.step(new Map()); // both heads -> (6,5)
    expect(game.snakeById("long")!.alive).toBe(true);
    expect(game.snakeById("short")!.alive).toBe(false);
  });
});

describe("new mechanics", () => {
  it("kills a snake that runs into an obstacle", () => {
    const game = single(cfg());
    game.obstacles.add("6,5");
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.step(new Map());
    expect(game.snakeById("s1")!.alive).toBe(false);
  });

  it("absorbs length from the loser of a head-to-head", () => {
    const game = Game.create(
      [
        { id: "long", displayName: "long", isNpc: false },
        { id: "short", displayName: "short", isNpc: false },
      ],
      "seed",
      cfg({ width: 20 }),
    );
    // loser length 4 -> winner gains floor(4 * 0.5) = 2 pending growth.
    setBody(game, "long", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
      { x: 2, y: 5 },
      { x: 1, y: 5 },
    ]);
    setBody(game, "short", "left", [
      { x: 7, y: 5 },
      { x: 8, y: 5 },
      { x: 9, y: 5 },
      { x: 10, y: 5 },
    ]);
    game.step(new Map());
    const winner = game.snakeById("long")!;
    expect(winner.alive).toBe(true);
    expect(winner.pendingGrowth).toBe(2);
  });

  it("doubles food value while frenzy is active", () => {
    const game = single(cfg({ width: 20 }));
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.snakeById("s1")!.frenzyUntil = 999;
    game.food.set("6,5", 3); // frenzy -> worth 6
    game.step(new Map());
    // +1 grown this tick, +5 still owed
    expect(game.snakeById("s1")!.pendingGrowth).toBe(5);
  });

  it("sheds tail segments into food", () => {
    const game = single(cfg({ width: 20 }));
    setBody(game, "s1", "right", [
      { x: 8, y: 5 },
      { x: 7, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.step(new Map([["s1", "right"]]), new Set(["s1"]));
    // length 6 -> move keeps 6, shed 3 down to minLength 3
    expect(game.snakeById("s1")!.body.length).toBe(3);
    expect(game.food.size).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  const roster: Participant[] = (
    ["greedy", "survivor", "hunter", "glutton", "random"] as const
  ).map((kind, i) => ({
    id: `npc_${kind}_${i}`,
    displayName: `npc_${kind}`,
    isNpc: true,
    npcKind: kind,
  }));

  const small = cfg({ width: 40, height: 40, foodTarget: 30, maxTicks: 300 });

  it("produces identical replays for the same seed", () => {
    const a = runMatch(roster, "determinism_seed", small);
    const b = runMatch(roster, "determinism_seed", small);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("produces different results for different seeds", () => {
    const a = runMatch(roster, "seed_a", small);
    const b = runMatch(roster, "seed_b", small);
    expect(JSON.stringify(a.frames)).not.toEqual(JSON.stringify(b.frames));
  });
});
