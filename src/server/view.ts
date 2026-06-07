import type { Game } from "../engine/game.js";
import { type Cell, type Direction } from "../types.js";

export interface FoodView {
  x: number;
  y: number;
  value: number;
}

/** One past move and how the engine treated it, fed back to the agent so it has
 * short-term memory of what it did. `move` is the direction it submitted ("none"
 * if it timed out); `legal` is false when the move was rejected as an illegal
 * neck-reversal (the engine ignores it and the snake keeps its heading). */
export interface RecentMove {
  tick: number;
  move: Direction | "none";
  legal: boolean;
}

export interface AgentView {
  schema_version: 1;
  tick: number;
  world: { width: number; height: number };
  vision: { center_x: number; center_y: number; radius: number };
  you: {
    id: string;
    heading: Direction;
    length: number;
    peak_size: number;
    combo: number;
    /** Ticks this snake has spent inside the scoring zone ("zone" objective). */
    zone_ticks: number;
    /** Waypoints reached so far ("relay" objective). */
    waypoints_done: number;
    /** The next waypoint to head for ("relay" objective), or null. */
    next_waypoint: Cell | null;
    head: Cell;
    body: Cell[];
    /** The agent's own last few moves (oldest first) with their legality, so it
     * can learn from rejected/illegal moves without re-deriving the rules. */
    recent_moves: RecentMove[];
  };
  food: FoodView[];
  obstacles: Cell[];
  snakes: Array<{
    id: string;
    display_name_untrusted: string;
    is_npc: boolean;
    length: number;
    head: Cell;
    body: Cell[];
  }>;
  action_deadline_tick: number;
  action_deadline_ms: number;
}

function decode(k: string): Cell {
  const [x, y] = k.split(",").map(Number) as [number, number];
  return { x, y };
}

/**
 * Build the vision-scoped state payload for one agent. Everything is clipped to
 * a Manhattan radius around the agent's head — never a full map dump. This both
 * keeps prompts small and makes the game a partial-information reasoning task.
 *
 * The world's RNG seed is deliberately NOT included: the engine is fully
 * deterministic, so leaking the seed would let an agent reconstruct the entire
 * map (obstacles, future food spawns) outside its vision and defeat the
 * partial-observability the benchmark is built on.
 */
export function buildAgentView(
  game: Game,
  snakeId: string,
  actionDeadlineMs: number,
  recentMoves: RecentMove[] = [],
): AgentView {
  const me = game.snakeById(snakeId);
  if (!me) throw new Error(`Unknown snake: ${snakeId}`);

  const head = me.body[0]!;
  const radius = game.config.visionRadius;
  const visible = (c: Cell) => Math.abs(c.x - head.x) + Math.abs(c.y - head.y) <= radius;

  const food: FoodView[] = [];
  for (const [k, value] of game.food) {
    const c = decode(k);
    if (visible(c)) food.push({ x: c.x, y: c.y, value });
  }

  const obstacles: Cell[] = [];
  for (const k of game.obstacles) {
    const c = decode(k);
    if (visible(c)) obstacles.push(c);
  }

  const snakes = game.snakes
    .filter((s) => s.id !== snakeId && s.alive)
    .map((s) => ({
      id: s.id,
      display_name_untrusted: s.displayName,
      is_npc: s.isNpc,
      length: s.body.length,
      head: { ...s.body[0]! },
      body: s.body.filter(visible).map((c) => ({ ...c })),
    }))
    .filter((s) => visible(s.head) || s.body.length > 0);

  return {
    schema_version: 1,
    tick: game.tick,
    world: { width: game.config.width, height: game.config.height },
    vision: { center_x: head.x, center_y: head.y, radius },
    you: {
      id: me.id,
      heading: me.heading,
      length: me.body.length,
      peak_size: me.peakSize,
      combo: me.comboLevel,
      zone_ticks: me.zoneTicks,
      waypoints_done: me.waypointIndex,
      next_waypoint: game.config.waypoints?.[me.waypointIndex]
        ? { ...game.config.waypoints[me.waypointIndex]! }
        : null,
      head: { ...head },
      body: me.body.filter(visible).map((c) => ({ ...c })),
      recent_moves: recentMoves,
    },
    food,
    obstacles,
    snakes,
    action_deadline_tick: game.tick + 1,
    action_deadline_ms: actionDeadlineMs,
  };
}
