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
  seed: string;
  world: { width: number; height: number };
  vision: { center_x: number; center_y: number; radius: number };
  you: {
    id: string;
    heading: Direction;
    length: number;
    peak_size: number;
    combo: number;
    frenzy_ticks_left: number;
    can_shed: boolean;
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
 */
export function buildAgentView(
  game: Game,
  snakeId: string,
  actionDeadlineMs: number,
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
    seed: game.seed,
    world: { width: game.config.width, height: game.config.height },
    vision: { center_x: head.x, center_y: head.y, radius },
    you: {
      id: me.id,
      heading: me.heading,
      length: me.body.length,
      peak_size: me.peakSize,
      combo: me.comboLevel,
      frenzy_ticks_left: Math.max(0, me.frenzyUntil - game.tick),
      can_shed: me.body.length > game.config.shedMinLength,
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
