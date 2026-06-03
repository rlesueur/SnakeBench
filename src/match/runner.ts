import { DEFAULT_CONFIG, type GameConfig } from "../config.js";
import { Game } from "../engine/game.js";
import { Rng } from "../rng.js";
import { NPC_REGISTRY, type NpcKind } from "../npc/bots.js";
import { type Cell, type Direction } from "../types.js";

export interface Participant {
  id: string;
  displayName: string;
  isNpc: boolean;
  /** Required when isNpc is true. */
  npcKind?: NpcKind;
}

export interface FrameSnake {
  id: string;
  alive: boolean;
  body: Cell[];
  size: number;
  peakSize: number;
}

export interface FrameFood {
  x: number;
  y: number;
  value: number;
}

export interface Frame {
  tick: number;
  snakes: FrameSnake[];
  food: FrameFood[];
}

export interface Standing {
  id: string;
  displayName: string;
  isNpc: boolean;
  peakSize: number;
  diedAtTick: number | null;
  rank: number;
}

export interface Replay {
  schemaVersion: 1;
  seed: string;
  config: GameConfig;
  participants: Participant[];
  /** Per-tick chosen moves, enough to re-simulate deterministically. */
  actions: Array<Record<string, Direction>>;
  /** Per-tick snapshots for rendering without re-simulation. */
  frames: Frame[];
  standings: Standing[];
}

function snapshot(game: Game): Frame {
  const food: FrameFood[] = [];
  for (const [k, value] of game.food) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    food.push({ x, y, value });
  }
  return {
    tick: game.tick,
    food,
    snakes: game.snakes.map((s) => ({
      id: s.id,
      alive: s.alive,
      body: s.body.map((c) => ({ ...c })),
      size: game.sizeOf(s),
      peakSize: s.peakSize,
    })),
  };
}

export function runMatch(
  participants: Participant[],
  seed: string,
  config: GameConfig = DEFAULT_CONFIG,
): Replay {
  const game = Game.create(
    participants.map((p) => ({ id: p.id, displayName: p.displayName, isNpc: p.isNpc })),
    seed,
    config,
  );

  // Each NPC gets its own deterministic RNG, independent of the engine's.
  const npcRng = new Map<string, Rng>();
  for (const p of participants) {
    if (p.isNpc) npcRng.set(p.id, new Rng(`${seed}:${p.id}`));
  }

  const actions: Array<Record<string, Direction>> = [];
  const frames: Frame[] = [snapshot(game)];

  while (game.aliveSnakes().length > 1 && game.tick < config.maxTicks) {
    const moves = new Map<string, Direction>();
    const record: Record<string, Direction> = {};
    for (const snake of game.aliveSnakes()) {
      const p = participants.find((x) => x.id === snake.id)!;
      if (p.isNpc) {
        const bot = NPC_REGISTRY[p.npcKind ?? "random"]!;
        const move = bot.decide(game, snake.id, npcRng.get(snake.id)!);
        moves.set(snake.id, move);
        record[snake.id] = move;
      }
    }
    actions.push(record);
    game.step(moves);
    frames.push(snapshot(game));
  }

  const standings = buildStandings(game);
  return {
    schemaVersion: 1,
    seed,
    config,
    participants,
    actions,
    frames,
    standings,
  };
}

function buildStandings(game: Game): Standing[] {
  const sorted = [...game.snakes].sort((a, b) => {
    if (b.peakSize !== a.peakSize) return b.peakSize - a.peakSize;
    // Survivors outrank earlier deaths at equal peak size.
    const ad = a.diedAtTick ?? Infinity;
    const bd = b.diedAtTick ?? Infinity;
    return bd - ad;
  });
  return sorted.map((s, i) => ({
    id: s.id,
    displayName: s.displayName,
    isNpc: s.isNpc,
    peakSize: s.peakSize,
    diedAtTick: s.diedAtTick,
    rank: i + 1,
  }));
}
