/**
 * Server-authoritative decision-quality analysis. Given the board *before* a
 * tick is stepped and the move a snake actually submitted, judge how good that
 * move was — independent of luck and of any client-reported "evidence".
 *
 * "Immediately safe" is an approximation of the engine's collision rules: a
 * candidate head cell is safe if it is in-bounds, not an obstacle, and not a
 * body segment that will still be occupied next tick (tails vacate, so they are
 * excluded; growth is ignored). It is intentionally simple and conservative —
 * good enough to flag blunders and avoidable deaths without simulating every
 * opponent's move.
 */
import { type Cell, type Direction, DIRECTIONS, DELTA, OPPOSITE, cellKey } from "../types.js";
import type { HeadToHead } from "../config.js";

/**
 * Cells an opponent head could move into next tick, mapped to the shortest and
 * longest such opponent. A snake can't reverse, so each enemy threatens its
 * three non-reverse neighbours. Tracking both extremes lets us flag head-to-head
 * danger under any rule (longest-wins, shortest-wins, or both-die).
 */
function contestedCells(enemyHeads: EnemyHead[] | undefined): Map<string, { min: number; max: number }> {
  const m = new Map<string, { min: number; max: number }>();
  if (!enemyHeads) return m;
  for (const e of enemyHeads) {
    const reverse = OPPOSITE[e.heading];
    for (const d of DIRECTIONS) {
      if (d === reverse) continue;
      const k = cellKey({ x: e.head.x + DELTA[d].x, y: e.head.y + DELTA[d].y });
      const cur = m.get(k);
      if (!cur) m.set(k, { min: e.length, max: e.length });
      else {
        cur.min = Math.min(cur.min, e.length);
        cur.max = Math.max(cur.max, e.length);
      }
    }
  }
  return m;
}

/** Flood-fill cap for the reachable-space metric (matches the agent's own). */
export const SPACE_CAP = 256;

export interface EnemyHead {
  head: Cell;
  heading: Direction;
  /** Full length of the enemy (decides who wins a head-to-head). */
  length: number;
}

export interface MoveContext {
  width: number;
  height: number;
  /** Static obstacle cells, keyed "x,y". */
  obstacles: Set<string>;
  /** Body segments occupied this tick that persist next tick (all alive
   * snakes' bodies excluding their tails), keyed "x,y". */
  blocked: Set<string>;
  head: Cell;
  heading: Direction;
  /** The move the agent submitted, or null if it missed the deadline. */
  submittedMove: Direction | null;
  /** This snake's own length, used to judge head-to-head danger. */
  selfLength?: number;
  /** Other alive snakes' heads, used to flag cells an opponent head could enter
   * next tick (a head-to-head a same-or-longer enemy would win). */
  enemyHeads?: EnemyHead[];
  /** Head-to-head rule in force this round (defaults to longest-wins). */
  headToHead?: HeadToHead;
}

export interface MoveAnalysis {
  /** A move was submitted, valid, and not a reversal into the neck. */
  legal: boolean;
  /** No move was submitted this tick (the snake continued on its heading). */
  timeout: boolean;
  /** At least one of the candidate moves was immediately safe. */
  hadSafeAlternative: boolean;
  /** The move the engine will actually apply lands on an immediately safe cell. */
  choseSafe: boolean;
  /** Reachable free space from the resulting head (4-connected, capped). */
  spaceAfter: number;
}

function inBounds(c: Cell, width: number, height: number): boolean {
  return c.x >= 0 && c.x < width && c.y >= 0 && c.y < height;
}

function isSafeCell(c: Cell, ctx: MoveContext): boolean {
  if (!inBounds(c, ctx.width, ctx.height)) return false;
  const k = cellKey(c);
  return !ctx.obstacles.has(k) && !ctx.blocked.has(k);
}

/** Count free cells reachable from `start` (4-connected), capped at SPACE_CAP. */
export function reachableSpace(start: Cell, ctx: MoveContext): number {
  if (!isSafeCell(start, ctx)) return 0;
  const seen = new Set<string>([cellKey(start)]);
  const queue: Cell[] = [start];
  let count = 0;
  while (queue.length && count < SPACE_CAP) {
    const c = queue.shift()!;
    count += 1;
    for (const d of DIRECTIONS) {
      const n = { x: c.x + DELTA[d].x, y: c.y + DELTA[d].y };
      const k = cellKey(n);
      if (seen.has(k)) continue;
      if (!inBounds(n, ctx.width, ctx.height) || ctx.obstacles.has(k) || ctx.blocked.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return count;
}

export function analyseMove(ctx: MoveContext): MoveAnalysis {
  const reverse = OPPOSITE[ctx.heading];
  const submitted = ctx.submittedMove;
  const timeout = submitted === null;
  // A reversal is illegal; the engine coerces it (and a timeout) to "continue".
  const legal = submitted !== null && submitted !== reverse;
  const effectiveDir: Direction = legal ? submitted : ctx.heading;

  // A cell is "safe" if it is physically clear *and* not a head-to-head we would
  // lose under the round's rule. Under longest-wins a same-or-longer enemy is
  // the threat; under shortest-wins a same-or-shorter enemy is; under all-die
  // any contesting enemy makes the cell deadly.
  const contested = contestedCells(ctx.enemyHeads);
  const selfLength = ctx.selfLength ?? Number.POSITIVE_INFINITY;
  const mode: HeadToHead = ctx.headToHead ?? "longest";
  const safe = (cell: Cell): boolean => {
    if (!isSafeCell(cell, ctx)) return false;
    const threat = contested.get(cellKey(cell));
    if (!threat) return true;
    if (mode === "all_die") return false;
    if (mode === "shortest") return threat.min > selfLength;
    return threat.max < selfLength;
  };

  // Candidate moves are the three non-reverse directions.
  const candidates = DIRECTIONS.filter((d) => d !== reverse);
  let hadSafeAlternative = false;
  for (const d of candidates) {
    const cell = { x: ctx.head.x + DELTA[d].x, y: ctx.head.y + DELTA[d].y };
    if (safe(cell)) {
      hadSafeAlternative = true;
      break;
    }
  }

  const newHead = { x: ctx.head.x + DELTA[effectiveDir].x, y: ctx.head.y + DELTA[effectiveDir].y };
  const choseSafe = safe(newHead);
  const spaceAfter = reachableSpace(newHead, ctx);

  return { legal, timeout, hadSafeAlternative, choseSafe, spaceAfter };
}
