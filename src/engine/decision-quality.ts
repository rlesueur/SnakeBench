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
import {
  type Law,
  applyTransform,
  constraintViolation,
  lethalFoodValue,
  obstaclesPassable,
} from "./laws.js";

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
  /** The round's natural-language laws. When present, the analysis becomes
   * law-aware: the submitted direction is remapped by transform laws, a move
   * that breaks a constraint law (or eats lethal food under inversion) is unsafe,
   * and obstacles are passable under inversion — so a move is judged exactly as
   * the engine will resolve it, not by plain physics. */
  laws?: readonly Law[];
  /** Food value by cell key, needed to flag lethal big food under inversion. */
  food?: Map<string, number>;
  /** Current tick, needed to judge the cadence ("tidal pull") constraint law. */
  tick?: number;
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
  // Under inversion, obstacles are harmless to enter, so they no longer block.
  const obstacleBlocks = ctx.obstacles.has(k) && !obstaclesPassable(ctx.laws ?? []);
  return !obstacleBlocks && !ctx.blocked.has(k);
}

/** Count free cells reachable from `start` (4-connected), capped at SPACE_CAP. */
export function reachableSpace(start: Cell, ctx: MoveContext): number {
  if (!isSafeCell(start, ctx)) return 0;
  const passObstacles = obstaclesPassable(ctx.laws ?? []);
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
      if (!inBounds(n, ctx.width, ctx.height) || ctx.blocked.has(k)) continue;
      if (ctx.obstacles.has(k) && !passObstacles) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return count;
}

export function analyseMove(ctx: MoveContext): MoveAnalysis {
  const laws = ctx.laws ?? [];
  const reverse = OPPOSITE[ctx.heading];
  const hasNeck = (ctx.selfLength ?? 2) > 1;
  const lethalFood = lethalFoodValue(laws);

  // The real heading the engine applies for a *submitted* direction: transform
  // laws remap it first, then the neck-reversal guard coerces a reversal back to
  // "continue straight" (exactly as step() does).
  const effective = (submitted: Direction): Direction => {
    const d = applyTransform(submitted, laws);
    return hasNeck && d === reverse ? ctx.heading : d;
  };

  const submitted = ctx.submittedMove;
  const timeout = submitted === null;
  // On a timeout the engine still feeds the current heading through transforms.
  const effectiveDir = effective(submitted ?? ctx.heading);
  // "Legal" = a move was submitted that isn't coerced into a neck reversal. With
  // no laws this reduces to "submitted and not the reverse direction".
  const legal = submitted !== null && !(hasNeck && applyTransform(submitted, laws) === reverse);

  // A cell is "safe" if it is physically clear, not a head-to-head we would lose
  // under the round's rule, AND not a death by law (a broken constraint law, or
  // eating lethal big food under inversion). Under longest-wins a same-or-longer
  // enemy is the threat; under shortest-wins a same-or-shorter enemy is; under
  // all-die any contesting enemy makes the cell deadly.
  const contested = contestedCells(ctx.enemyHeads);
  const selfLength = ctx.selfLength ?? Number.POSITIVE_INFINITY;
  const mode: HeadToHead = ctx.headToHead ?? "longest";
  const cellOf = (dir: Direction): Cell => ({ x: ctx.head.x + DELTA[dir].x, y: ctx.head.y + DELTA[dir].y });
  const lawful = (dir: Direction, cell: Cell): boolean => {
    if (laws.length === 0) return true;
    const violated = constraintViolation(laws, {
      prevHead: ctx.head,
      prevHeading: ctx.heading,
      heading: dir,
      newHead: cell,
      tick: ctx.tick ?? 0,
    });
    if (violated) return false;
    if (lethalFood != null && ctx.food && (ctx.food.get(cellKey(cell)) ?? 0) >= lethalFood) return false;
    return true;
  };
  // Judge a *submitted* direction by where the engine will actually put the head.
  const safe = (submittedDir: Direction): boolean => {
    const dir = effective(submittedDir);
    const cell = cellOf(dir);
    if (!isSafeCell(cell, ctx)) return false;
    if (!lawful(dir, cell)) return false;
    const threat = contested.get(cellKey(cell));
    if (!threat) return true;
    if (mode === "all_die") return false;
    if (mode === "shortest") return threat.min > selfLength;
    return threat.max < selfLength;
  };

  // A safe alternative exists if any of the four submittable directions resolves
  // (after laws) to a safe, lawful cell.
  let hadSafeAlternative = false;
  for (const d of DIRECTIONS) {
    if (safe(d)) {
      hadSafeAlternative = true;
      break;
    }
  }

  const newHead = cellOf(effectiveDir);
  const choseSafe = submitted !== null ? safe(submitted) : safe(ctx.heading);
  const spaceAfter = reachableSpace(newHead, ctx);

  return { legal, timeout, hadSafeAlternative, choseSafe, spaceAfter };
}
