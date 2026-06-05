import type { Game } from "../engine/game.js";
import { type Cell, type Direction } from "../types.js";

export interface FoodView {
  x: number;
  y: number;
  value: number;
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
    frenzy_ticks_left: number;
    ghost_ticks_left: number;
    flare_ticks_left: number;
    magnet_ticks_left: number;
    /** Ticks this snake has spent inside the scoring zone ("zone" objective). */
    zone_ticks: number;
    /** Waypoints reached so far ("relay" objective). */
    waypoints_done: number;
    /** The next waypoint to head for ("relay" objective), or null. */
    next_waypoint: Cell | null;
    head: Cell;
    body: Cell[];
  };
  food: FoodView[];
  obstacles: Cell[];
  power_ups: Array<{ x: number; y: number; kind: string }>;
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
): AgentView {
  const me = game.snakeById(snakeId);
  if (!me) throw new Error(`Unknown snake: ${snakeId}`);

  const head = me.body[0]!;
  // A vision flare temporarily widens this snake's sight radius.
  const flared = me.flareUntil > game.tick;
  const radius = game.config.visionRadius + (flared ? game.config.flareVisionBonus : 0);
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

  const power_ups: Array<{ x: number; y: number; kind: string }> = [];
  for (const [k, kind] of game.powerUps) {
    const c = decode(k);
    if (visible(c)) power_ups.push({ x: c.x, y: c.y, kind });
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
      frenzy_ticks_left: Math.max(0, me.frenzyUntil - game.tick),
      ghost_ticks_left: Math.max(0, me.ghostUntil - game.tick),
      flare_ticks_left: Math.max(0, me.flareUntil - game.tick),
      magnet_ticks_left: Math.max(0, me.magnetUntil - game.tick),
      zone_ticks: me.zoneTicks,
      waypoints_done: me.waypointIndex,
      next_waypoint: game.config.waypoints?.[me.waypointIndex]
        ? { ...game.config.waypoints[me.waypointIndex]! }
        : null,
      head: { ...head },
      body: me.body.filter(visible).map((c) => ({ ...c })),
    },
    food,
    obstacles,
    power_ups,
    snakes,
    action_deadline_tick: game.tick + 1,
    action_deadline_ms: actionDeadlineMs,
  };
}
