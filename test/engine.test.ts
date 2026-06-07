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

  it("inverts head-to-head when the rule is shortest-wins", () => {
    const game = Game.create(
      [
        { id: "long", displayName: "long", isNpc: false },
        { id: "short", displayName: "short", isNpc: false },
      ],
      "seed",
      cfg({ headToHead: "shortest" }),
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
    expect(game.snakeById("short")!.alive).toBe(true);
    expect(game.snakeById("long")!.alive).toBe(false);
  });

  it("kills both snakes in a head-to-head when the rule is all_die", () => {
    const game = Game.create(
      [
        { id: "long", displayName: "long", isNpc: false },
        { id: "short", displayName: "short", isNpc: false },
      ],
      "seed",
      cfg({ headToHead: "all_die" }),
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
    expect(game.snakeById("short")!.alive).toBe(false);
    expect(game.snakeById("long")!.alive).toBe(false);
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

  it("withers a snake that hasn't eaten under famine (length tax)", () => {
    const game = single(cfg({ width: 40, lengthTaxTicks: 4 }));
    setBody(game, "s1", "right", [
      { x: 8, y: 5 },
      { x: 7, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
    ]);
    for (let i = 0; i < 5; i++) game.step(new Map([["s1", "right"]]));
    // At tick 4 (tick % 4 === 0) with no food eaten, it loses one tail segment.
    expect(game.snakeById("s1")!.body.length).toBe(4);
  });

  it("places a high-value special food on the board", () => {
    const game = single(cfg({ width: 20 }));
    game.addSpecialFood(12, 1);
    const golden = [...game.food.values()].filter((v) => v >= 12);
    expect(golden.length).toBe(1);
  });

  it("credits a cut-off kill when an enemy runs into your body", () => {
    const game = Game.create(
      [
        { id: "k", displayName: "k", isNpc: false },
        { id: "v", displayName: "v", isNpc: false },
      ],
      "seed",
      cfg({ width: 20 }),
    );
    setBody(game, "k", "left", [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ]);
    setBody(game, "v", "down", [
      { x: 6, y: 4 },
      { x: 6, y: 3 },
    ]);
    const events = game.step(new Map([["k", "left"], ["v", "down"]])); // v -> (6,5) = k's body
    expect(game.snakeById("v")!.alive).toBe(false);
    expect(game.snakeById("k")!.alive).toBe(true);
    const kill = events.find((e) => e.kind === "kill");
    expect(kill && kill.kind === "kill" && kill.id).toBe("k");
    expect(kill && kill.kind === "kill" && kill.victim).toBe("v");
  });

  it("grants the killer growth under a bounty (cut-off absorb)", () => {
    const game = Game.create(
      [
        { id: "k", displayName: "k", isNpc: false },
        { id: "v", displayName: "v", isNpc: false },
      ],
      "seed",
      cfg({ width: 20, cutoffAbsorbFraction: 0.5 }),
    );
    setBody(game, "k", "left", [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ]);
    setBody(game, "v", "down", [
      { x: 6, y: 4 },
      { x: 6, y: 3 },
    ]);
    game.step(new Map([["k", "left"], ["v", "down"]]));
    expect(game.snakeById("k")!.pendingGrowth).toBe(1); // floor(2 * 0.5)
  });

  it("tallies a zone tick only while the head is inside the scoring zone", () => {
    const game = single(cfg({ width: 30, height: 30, scoreZone: { x: 10, y: 10, w: 4, h: 4 } }));
    setBody(game, "s1", "right", [
      { x: 8, y: 10 },
      { x: 7, y: 10 },
      { x: 6, y: 10 },
    ]);
    game.step(new Map([["s1", "right"]])); // -> (9,10) still outside
    expect(game.snakeById("s1")!.zoneTicks).toBe(0);
    game.step(new Map([["s1", "right"]])); // -> (10,10) inside
    expect(game.snakeById("s1")!.zoneTicks).toBe(1);
    game.step(new Map([["s1", "right"]])); // -> (11,10) still inside
    expect(game.snakeById("s1")!.zoneTicks).toBe(2);
  });

  it("advances the relay waypoint index and emits an event when reached", () => {
    const game = single(cfg({ width: 30, height: 30, waypoints: [{ x: 8, y: 10 }, { x: 8, y: 12 }] }));
    setBody(game, "s1", "right", [
      { x: 6, y: 10 },
      { x: 5, y: 10 },
      { x: 4, y: 10 },
    ]);
    game.step(new Map([["s1", "right"]])); // -> (7,10), not yet
    expect(game.snakeById("s1")!.waypointIndex).toBe(0);
    const events = game.step(new Map([["s1", "right"]])); // -> (8,10) = waypoint 1
    expect(game.snakeById("s1")!.waypointIndex).toBe(1);
    expect(events.some((e) => e.kind === "waypoint" && e.index === 1)).toBe(true);
  });

  it("poison food kills the snake that eats it but small pellets are safe", () => {
    const game = single(cfg({ width: 20, poisonValue: 3 }));
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.food.clear();
    game.food.set("6,5", 1); // safe pellet ahead
    game.step(new Map([["s1", "right"]]));
    expect(game.snakeById("s1")!.alive).toBe(true);
    game.food.set("7,5", 6); // poison ahead
    game.step(new Map([["s1", "right"]]));
    expect(game.snakeById("s1")!.alive).toBe(false);
  });

  it("a long snake can cut off and kill a rival (viable hunting)", () => {
    const game = Game.create(
      [
        { id: "k", displayName: "k", isNpc: false },
        { id: "v", displayName: "v", isNpc: false },
      ],
      "seed",
      cfg({ width: 20, startingLength: 6 }),
    );
    // Killer lies across the row; victim is forced down into the killer's body.
    setBody(game, "k", "left", [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
      { x: 8, y: 5 },
      { x: 9, y: 5 },
      { x: 10, y: 5 },
    ]);
    setBody(game, "v", "down", [
      { x: 6, y: 4 },
      { x: 6, y: 3 },
    ]);
    const events = game.step(new Map([["k", "left"], ["v", "down"]])); // v -> (6,5) = k's body
    expect(game.snakeById("v")!.alive).toBe(false);
    expect(game.snakeById("k")!.alive).toBe(true);
    expect(events.some((e) => e.kind === "kill" && e.id === "k" && e.victim === "v")).toBe(true);
  });

  it("carnivore rounds give no growth from food", () => {
    const game = single(cfg({ width: 20, foodGrows: false }));
    setBody(game, "s1", "right", [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ]);
    game.food.clear();
    game.food.set("6,5", 6); // a juicy pellet right ahead
    game.step(new Map([["s1", "right"]])); // eat it
    expect(game.snakeById("s1")!.pendingGrowth).toBe(0); // no growth
    expect(game.food.has("6,5")).toBe(false); // still consumed/cleared
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
