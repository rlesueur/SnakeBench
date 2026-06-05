import type { Game } from "../engine/game.js";
import type { Rng } from "../rng.js";
import { type Cell, type Direction, DELTA, DIRECTIONS, OPPOSITE, cellKey } from "../types.js";
import { type Npc, headAfter, legalDirections, manhattan, bestValueFood } from "./helpers.js";

/**
 * A strong, deterministic lookahead bot — the benchmark's "ceiling anchor".
 *
 * Unlike the simple heuristic NPCs (one-ply food/flood-fill), this plays the way
 * competitive hand-written snake bots do: it scores each candidate move by
 *
 *   1. **Voronoi area control** — how much of the board its head would reach
 *      strictly before any rival head (simultaneous multi-source BFS). This is
 *      the dominant positional signal in snake-like games.
 *   2. **Connected free space** — a flood fill from the new head; if the
 *      reachable region is smaller than the snake's length it is about to trap
 *      itself, which is penalised hard.
 *   3. **Head-to-head outcomes** — modelling that a rival who can step onto the
 *      same cell wins if it is at least as long (longest-survives rule).
 *   4. **Food pull** — a smaller term, only worth chasing when space is safe.
 *
 * It exists to answer "how well can a non-reasoning program play this game?" —
 * the gap between it and an LLM agent is the benchmark's real reasoning signal.
 * It uses full game state (like all NPCs); that makes it an upper bound, not a
 * vision-limited peer.
 */

const NEIGHBOURS: ReadonlyArray<Cell> = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function inBounds(game: Game, c: Cell): boolean {
  return c.x >= 0 && c.x < game.config.width && c.y >= 0 && c.y < game.config.height;
}

/** Cells that are lethal to enter next tick: walls/obstacles plus every snake
 * body segment except tails (which vacate). */
function blockedCells(game: Game): Set<string> {
  const blocked = new Set<string>(game.obstacles);
  for (const s of game.aliveSnakes()) {
    for (let i = 0; i < s.body.length - 1; i++) blocked.add(cellKey(s.body[i]!));
  }
  return blocked;
}

/** Flood-fill size of the connected free region reachable from `start`. */
function reachableSpace(game: Game, start: Cell, blocked: Set<string>, cap: number): number {
  if (!inBounds(game, start) || blocked.has(cellKey(start))) return 0;
  const seen = new Set<string>([cellKey(start)]);
  const stack: Cell[] = [start];
  let count = 0;
  while (stack.length && count < cap) {
    const c = stack.pop()!;
    count += 1;
    for (const d of NEIGHBOURS) {
      const n = { x: c.x + d.x, y: c.y + d.y };
      if (!inBounds(game, n)) continue;
      const k = cellKey(n);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      stack.push(n);
    }
  }
  return count;
}

/** Count cells my head (at `myHead`) reaches strictly sooner than any rival head,
 * via layered simultaneous BFS (a Voronoi partition of the free board). */
function controlledArea(
  game: Game,
  selfId: string,
  myHead: Cell,
  blocked: Set<string>,
  cap: number,
): number {
  const owner = new Map<string, number>(); // 0 = me, 1 = a rival, 2 = contested (tie)
  let frontier: Array<{ c: Cell; who: number }> = [];

  const addSource = (c: Cell, who: number): void => {
    const k = cellKey(c);
    if (!owner.has(k)) {
      owner.set(k, who);
      frontier.push({ c, who });
    }
  };
  addSource(myHead, 0);
  for (const s of game.aliveSnakes()) {
    if (s.id === selfId) continue;
    addSource(s.body[0]!, 1);
  }

  let expanded = 0;
  while (frontier.length && expanded < cap) {
    const next: Array<{ c: Cell; who: number }> = [];
    // Claims made at this depth, resolved together so equidistant cells tie.
    const claims = new Map<string, { c: Cell; who: number }>();
    for (const { c, who } of frontier) {
      for (const d of NEIGHBOURS) {
        const n = { x: c.x + d.x, y: c.y + d.y };
        if (!inBounds(game, n)) continue;
        const k = cellKey(n);
        if (owner.has(k) || blocked.has(k)) continue;
        const existing = claims.get(k);
        if (!existing) claims.set(k, { c: n, who });
        else if (existing.who !== who) existing.who = 2; // tie -> contested
      }
    }
    for (const [k, { c, who }] of claims) {
      owner.set(k, who);
      expanded += 1;
      next.push({ c, who });
    }
    frontier = next;
  }

  let mine = 0;
  for (const who of owner.values()) if (who === 0) mine += 1;
  return mine;
}

/** Danger from rival heads that could step onto `myHead` next tick. Under the
 * survival-first ranking, even a "winning" trade is a needless risk, so any
 * contesting head is penalised — severely when it would win (>= our length). */
function headDanger(game: Game, selfId: string, selfLength: number, myHead: Cell): number {
  let penalty = 0;
  for (const s of game.aliveSnakes()) {
    if (s.id === selfId) continue;
    if (manhattan(s.body[0]!, myHead) === 1) {
      penalty -= s.body.length >= selfLength ? 600 : 40;
    }
  }
  return penalty;
}

/** Best connected free space available on the move *after* stepping to `from`
 * (heading `dir`). A 2-ply survival check the one-ply bots cannot see: it
 * catches moves into a pocket that is roomy now but a dead end next tick. */
function bestFollowupSpace(
  game: Game,
  from: Cell,
  dir: Direction,
  blocked: Set<string>,
  cap: number,
): number {
  const blocked2 = new Set(blocked);
  blocked2.add(cellKey(from)); // our new head becomes body next tick
  let best = 0;
  for (const nd of DIRECTIONS) {
    if (nd === OPPOSITE[dir]) continue; // cannot reverse into our neck
    const n = { x: from.x + DELTA[nd].x, y: from.y + DELTA[nd].y };
    if (!inBounds(game, n) || blocked2.has(cellKey(n))) continue;
    const s = reachableSpace(game, n, blocked2, cap);
    if (s > best) best = s;
  }
  return best;
}

export const searchBot: Npc = {
  kind: "searcher",
  decide(game, selfId, rng) {
    const self = game.snakeById(selfId)!;
    const blocked = blockedCells(game);
    const length = self.body.length;
    const spaceCap = Math.max(160, length * 4);
    const areaCap = 1200;

    let best: Direction[] = [];
    let bestScore = -Infinity;

    for (const d of legalDirections(self)) {
      const h = headAfter(self, d);
      let score: number;
      if (!inBounds(game, h) || blocked.has(cellKey(h))) {
        score = -1_000_000; // immediate death; only taken if nothing else is legal
      } else {
        // Survival is the objective: the limiting factor is the *worse* of the
        // space we have now and the space we can keep next tick (2-ply).
        const space1 = reachableSpace(game, h, blocked, spaceCap);
        const space2 = bestFollowupSpace(game, h, d, blocked, spaceCap);
        const survival = Math.min(space1, space2);
        score = survival * 3 + Math.min(space1, spaceCap) * 1;
        // Trap guard: a region smaller than our body means near-certain death.
        if (survival <= length) score -= (length - survival + 1) * 80;
        score += headDanger(game, selfId, length, h);
        // Area control is a positional tiebreak only; never worth a risk.
        score += controlledArea(game, selfId, h, blocked, areaCap) * 0.25;
        // Food matters only for the peak-size tiebreak, and only when very safe.
        if (survival > length * 2) {
          const food = bestValueFood(game, h);
          if (food) {
            const value = game.food.get(cellKey(food)) ?? 1;
            score += (value / (1 + manhattan(h, food))) * 1.5;
          }
        }
      }
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = [d];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        best.push(d);
      }
    }

    if (!best.length) return self.heading;
    return best.length === 1 ? best[0]! : (rng.pick(best) ?? best[0]!);
  },
};
