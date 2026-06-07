import type { Game } from "../engine/game.js";
import { type Cell } from "../types.js";

export interface SpectatorSnake {
  id: string;
  displayName: string;
  isNpc: boolean;
  alive: boolean;
  body: Cell[];
  size: number;
  peakSize: number;
  /** The snake's standing on THIS round's win condition (zone ticks, waypoints
   * reached, kills, peak length, current length…), or null when the objective is
   * plain survival (which has no separate per-snake score). */
  score: number | null;
  combo: number;
}

/** Context the arena passes so each snake's live `score` reflects how the round is
 * actually won, not just its length. */
export interface SnapshotOpts {
  /** The round objective ("survive" | "grow" | "kills" | "zone" | "relay" | "bell" | "fasting"). */
  objective?: string;
  /** Cut-off kill tally lookup for the round (used by the "kills" objective). */
  killsOf?: (id: string) => number;
}

export interface SpectatorFood {
  x: number;
  y: number;
  value: number;
}

export interface SpectatorFrame {
  tick: number;
  snakes: SpectatorSnake[];
  food: SpectatorFood[];
}

function decode(k: string): Cell {
  const [x, y] = k.split(",").map(Number) as [number, number];
  return { x, y };
}

/** Static map data sent once per round (obstacles), not every frame. */
export function staticMap(game: Game): { obstacles: Cell[] } {
  return { obstacles: [...game.obstacles].map(decode) };
}

/** Full, un-clipped world snapshot — for the spectator view and replays only. */
export function fullSnapshot(game: Game, opts: SnapshotOpts = {}): SpectatorFrame {
  const food: SpectatorFood[] = [];
  for (const [k, value] of game.food) {
    food.push({ ...decode(k), value });
  }
  // Mirror the arena's round-ranking metric so the live board scores the round the
  // way it will actually be won (see endRound's scoreOf).
  const scoreOf = (s: (typeof game.snakes)[number]): number | null => {
    switch (opts.objective) {
      case "zone": return s.zoneTicks;
      case "relay": return s.waypointIndex;
      case "kills": return opts.killsOf?.(s.id) ?? 0;
      case "grow": return s.peakSize;
      case "bell": return game.sizeOf(s);
      case "fasting": return game.sizeOf(s);
      default: return null; // survive: ranked by survival + length, no separate score
    }
  };
  return {
    tick: game.tick,
    food,
    snakes: game.snakes.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      isNpc: s.isNpc,
      alive: s.alive,
      body: s.body.map((c) => ({ ...c })),
      size: game.sizeOf(s),
      peakSize: s.peakSize,
      score: scoreOf(s),
      combo: s.comboLevel,
    })),
  };
}
