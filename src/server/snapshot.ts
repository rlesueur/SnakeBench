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
  frenzy: boolean;
  combo: number;
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
  powerUps: Array<{ x: number; y: number; kind: string }>;
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
export function fullSnapshot(game: Game): SpectatorFrame {
  const food: SpectatorFood[] = [];
  for (const [k, value] of game.food) {
    food.push({ ...decode(k), value });
  }
  const powerUps: Array<{ x: number; y: number; kind: string }> = [];
  for (const [k, kind] of game.powerUps) {
    powerUps.push({ ...decode(k), kind });
  }
  return {
    tick: game.tick,
    food,
    powerUps,
    snakes: game.snakes.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      isNpc: s.isNpc,
      alive: s.alive,
      body: s.body.map((c) => ({ ...c })),
      size: game.sizeOf(s),
      peakSize: s.peakSize,
      frenzy: s.frenzyUntil > game.tick,
      combo: s.comboLevel,
    })),
  };
}
