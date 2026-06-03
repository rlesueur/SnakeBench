import type { Game } from "../engine/game.js";
import type { Rng } from "../rng.js";
import {
  type Cell,
  type Direction,
  DELTA,
  DIRECTIONS,
  OPPOSITE,
  type Snake,
  cellKey,
} from "../types.js";

export interface Npc {
  readonly kind: string;
  decide(game: Game, selfId: string, rng: Rng): Direction;
}

export function leftOf(d: Direction): Direction {
  return { up: "left", left: "down", down: "right", right: "up" }[d] as Direction;
}

export function rightOf(d: Direction): Direction {
  return { up: "right", right: "down", down: "left", left: "up" }[d] as Direction;
}

export function headAfter(snake: Snake, dir: Direction): Cell {
  const head = snake.body[0]!;
  return { x: head.x + DELTA[dir].x, y: head.y + DELTA[dir].y };
}

/** Directions that are not an illegal reverse into the neck. */
export function legalDirections(snake: Snake): Direction[] {
  if (snake.body.length <= 1) return [...DIRECTIONS];
  const banned = OPPOSITE[snake.heading];
  return DIRECTIONS.filter((d) => d !== banned);
}

/**
 * Cells that would kill a snake next tick (approximate): walls, plus any snake
 * body cell except tails, which are assumed to vacate.
 */
function hazardCells(game: Game): Set<string> {
  const hazards = new Set<string>();
  for (const k of game.obstacles) hazards.add(k);
  for (const s of game.aliveSnakes()) {
    for (let i = 0; i < s.body.length - 1; i++) {
      hazards.add(cellKey(s.body[i]!));
    }
  }
  return hazards;
}

export function safeDirections(game: Game, snake: Snake): Direction[] {
  const hazards = hazardCells(game);
  return legalDirections(snake).filter((d) => {
    const h = headAfter(snake, d);
    if (h.x < 0 || h.x >= game.config.width || h.y < 0 || h.y >= game.config.height) {
      return false;
    }
    return !hazards.has(cellKey(h));
  });
}

export function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function nearestFood(game: Game, from: Cell): Cell | undefined {
  let best: Cell | undefined;
  let bestDist = Infinity;
  for (const k of game.food.keys()) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const c = { x, y };
    const d = manhattan(from, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Food that maximises value per step away — used by the glutton bot. */
export function bestValueFood(game: Game, from: Cell): Cell | undefined {
  let best: Cell | undefined;
  let bestScore = -Infinity;
  for (const [k, value] of game.food) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const c = { x, y };
    const score = value / (1 + manhattan(from, c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Count of free cells reachable from `start`, capped, to gauge self-trapping. */
export function freeSpace(game: Game, start: Cell, cap = 200): number {
  const { width, height } = game.config;
  const hazards = hazardCells(game);
  const seen = new Set<string>();
  const stack: Cell[] = [start];
  let count = 0;
  while (stack.length && count < cap) {
    const c = stack.pop()!;
    if (c.x < 0 || c.x >= width || c.y < 0 || c.y >= height) continue;
    const k = cellKey(c);
    if (seen.has(k) || hazards.has(k)) continue;
    seen.add(k);
    count++;
    stack.push({ x: c.x - 1, y: c.y }, { x: c.x + 1, y: c.y });
    stack.push({ x: c.x, y: c.y - 1 }, { x: c.x, y: c.y + 1 });
  }
  return count;
}

export function towards(from: Cell, target: Cell, options: Direction[]): Direction | undefined {
  let best: Direction | undefined;
  let bestDist = Infinity;
  for (const d of options) {
    const next = { x: from.x + DELTA[d].x, y: from.y + DELTA[d].y };
    const dist = manhattan(next, target);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}
