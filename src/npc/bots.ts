import type { Game } from "../engine/game.js";
import type { Rng } from "../rng.js";
import { type Direction, type Snake } from "../types.js";
import {
  type Npc,
  bestValueFood,
  freeSpace,
  headAfter,
  legalDirections,
  manhattan,
  nearestFood,
  safeDirections,
  towards,
} from "./helpers.js";

function fallback(snake: Snake, rng: Rng, safe: Direction[]): Direction {
  const legal = legalDirections(snake);
  return rng.pick(safe.length ? safe : legal) ?? snake.heading;
}

/** Legal random moves: a survival floor and harness sanity check. */
export const randomBot: Npc = {
  kind: "random",
  decide(_game, _selfId, rng) {
    const snake = _game.snakeById(_selfId)!;
    return rng.pick(legalDirections(snake)) ?? snake.heading;
  },
};

/** Beelines to the nearest food; the basic competence bar. */
export const greedyBot: Npc = {
  kind: "greedy",
  decide(game, selfId, rng) {
    const snake = game.snakeById(selfId)!;
    const safe = safeDirections(game, snake);
    const food = nearestFood(game, snake.body[0]!);
    if (food) {
      const dir = towards(snake.body[0]!, food, safe.length ? safe : legalDirections(snake));
      if (dir) return dir;
    }
    return fallback(snake, rng, safe);
  },
};

/** Greedy for food but avoids walls/bodies and self-trapping via free-space lookahead. */
export const survivorBot: Npc = {
  kind: "survivor",
  decide(game, selfId, rng) {
    const snake = game.snakeById(selfId)!;
    const safe = safeDirections(game, snake);
    if (!safe.length) return fallback(snake, rng, safe);

    const food = nearestFood(game, snake.body[0]!);
    let best: Direction | undefined;
    let bestScore = -Infinity;
    for (const d of safe) {
      const next = headAfter(snake, d);
      const space = freeSpace(game, next);
      const foodPull = food ? -manhattan(next, food) : 0;
      // Prioritise not trapping ourselves; break ties towards food.
      const score = space * 10 + foodPull;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best ?? fallback(snake, rng, safe);
  },
};

/** Aggressive: hunts the nearest strictly-shorter snake's head to force a head-to-head win. */
export const hunterBot: Npc = {
  kind: "hunter",
  decide(game, selfId, rng) {
    const snake = game.snakeById(selfId)!;
    const safe = safeDirections(game, snake);
    if (!safe.length) return fallback(snake, rng, safe);

    let target: Snake | undefined;
    let bestDist = Infinity;
    for (const other of game.aliveSnakes()) {
      if (other.id === selfId) continue;
      if (other.body.length >= snake.body.length) continue; // only chase shorter prey
      const d = manhattan(snake.body[0]!, other.body[0]!);
      if (d < bestDist) {
        bestDist = d;
        target = other;
      }
    }

    if (target) {
      const dir = towards(snake.body[0]!, target.body[0]!, safe);
      if (dir) return dir;
    }
    // No prey: fall back to survivor behaviour.
    return survivorBot.decide(game, selfId, rng);
  },
};

/** Value-greedy: chases the highest-value food per step, while staying safe. */
export const gluttonBot: Npc = {
  kind: "glutton",
  decide(game, selfId, rng) {
    const snake = game.snakeById(selfId)!;
    const safe = safeDirections(game, snake);
    if (!safe.length) return fallback(snake, rng, safe);

    const target = bestValueFood(game, snake.body[0]!);
    if (target) {
      const dir = towards(snake.body[0]!, target, safe);
      if (dir) return dir;
    }
    // Nothing worth chasing: keep the most open space.
    let best: Direction | undefined;
    let bestSpace = -Infinity;
    for (const d of safe) {
      const space = freeSpace(game, headAfter(snake, d));
      if (space > bestSpace) {
        bestSpace = space;
        best = d;
      }
    }
    return best ?? fallback(snake, rng, safe);
  },
};

export const NPC_REGISTRY: Record<string, Npc> = {
  random: randomBot,
  greedy: greedyBot,
  survivor: survivorBot,
  hunter: hunterBot,
  glutton: gluttonBot,
};

export type NpcKind = keyof typeof NPC_REGISTRY;
