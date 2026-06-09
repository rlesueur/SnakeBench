import {
  runAgent,
  type Cell,
  type Decision,
  type Direction,
  type Food,
  type Intent,
  type State,
} from "./core.js";

/**
 * Sample agent client. It connects, reads the vision-scoped state each tick, and
 * plays a simple "seek food, avoid death" heuristic. This is a TEMPLATE: swap
 * `decideMove` for a call to your LLM (passing `state` straight into the prompt).
 *
 * Usage: npm run agent -- [key] [url]
 *   npm run agent
 *   npm run agent -- local-dev-key ws://localhost:8080
 */

const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function decideMove(state: State): Decision {
  const { you, world } = state;
  const head = you.head;

  const hazards = new Set<string>();
  const addBody = (b: Cell[]) => b.forEach((c) => hazards.add(`${c.x},${c.y}`));
  addBody(you.body);
  for (const s of state.snakes) addBody(s.body);
  for (const o of state.obstacles ?? []) hazards.add(`${o.x},${o.y}`);

  const banned = you.body.length > 1 ? OPPOSITE[you.heading] : null;
  const legal = DIRECTIONS.filter((d) => d !== banned);
  const safe = legal.filter((d) => {
    const n = { x: head.x + DELTA[d].x, y: head.y + DELTA[d].y };
    if (n.x < 0 || n.x >= world.width || n.y < 0 || n.y >= world.height) return false;
    return !hazards.has(`${n.x},${n.y}`);
  });

  const options = safe.length ? safe : legal;

  // How close is the nearest enemy head? Drives the "evading" intent.
  let nearestEnemy = Infinity;
  for (const s of state.snakes) {
    if (s.head) nearestEnemy = Math.min(nearestEnemy, manhattan(head, s.head));
  }

  // Head towards the most appealing visible food: nearest, with a mild
  // preference for higher-value pellets (value 1 / 3 / 6).
  let target: Food | undefined;
  let best = Infinity;
  for (const f of state.food) {
    const score = manhattan(head, f) - f.value;
    if (score < best) {
      best = score;
      target = f;
    }
  }

  let move = options[0] ?? you.heading;
  let movingToFood = false;
  if (target) {
    let bestDir: Direction | undefined;
    let bestDist = Infinity;
    for (const d of options) {
      const n = { x: head.x + DELTA[d].x, y: head.y + DELTA[d].y };
      const dist = manhattan(n, target);
      if (dist < bestDist) {
        bestDist = dist;
        bestDir = d;
      }
    }
    if (bestDir) {
      move = bestDir;
      movingToFood = bestDist < manhattan(head, target);
    }
  }

  // Declare an honest intent based on what the heuristic is actually doing.
  let intent: Intent;
  let tgt: string | null = null;
  if (!safe.length) {
    intent = "escaping";
  } else if (nearestEnemy <= 4) {
    intent = "evading";
  } else if (target && movingToFood) {
    intent = "feeding";
    tgt = target.value >= 6 ? "feast" : target.value >= 3 ? "fruit" : "pellet";
  } else {
    intent = "roaming";
  }
  return { move, intent, target: tgt };
}

runAgent({
  name: "heuristic",
  banner: "heuristic seek-food / avoid-death client",
  decide: ({ state }) => decideMove(state),
});
