import { WebSocket } from "ws";

/**
 * Sample agent client. It connects, reads the vision-scoped state each tick, and
 * plays a simple "seek food, avoid death" heuristic. This is a TEMPLATE: swap
 * `decideMove` for a call to your LLM (passing `state` straight into the prompt).
 *
 * Usage: npm run agent -- [key] [url]
 *   npm run agent
 *   npm run agent -- local-dev-key ws://localhost:8080
 */
type Direction = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };
const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

interface State {
  tick: number;
  world: { width: number; height: number };
  you: { heading: Direction; head: Cell; body: Cell[] };
  food: Cell[];
  obstacles: Cell[];
  snakes: Array<{ body: Cell[]; head: Cell }>;
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function decideMove(state: State): Direction {
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

  // Head towards the nearest visible food.
  let target: Cell | undefined;
  let best = Infinity;
  for (const f of state.food) {
    const d = manhattan(head, f);
    if (d < best) {
      best = d;
      target = f;
    }
  }
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
    if (bestDir) return bestDir;
  }
  return options[0] ?? you.heading;
}

function main(): void {
  const key = process.argv[2] ?? process.env.AGENT_KEY ?? "local-dev-key";
  const url = process.argv[3] ?? process.env.ARENA_URL ?? "ws://localhost:8080";
  const ws = new WebSocket(`${url}/agent?key=${encodeURIComponent(key)}`);

  ws.on("open", () => console.log(`Connected to ${url}`));
  ws.on("error", (err) => console.error("WS error:", err.message));
  ws.on("close", () => {
    console.log("Disconnected.");
    process.exit(0);
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.type) {
      case "welcome":
        console.log(`Welcome — you are ${msg.you_id}`);
        break;
      case "round_start":
        console.log(`Round ${msg.round} started.`);
        break;
      case "state": {
        const state = msg.state as State;
        const move = decideMove(state);
        ws.send(JSON.stringify({ type: "action", tick: state.tick, move }));
        break;
      }
      case "dead":
        console.log(`Died at tick ${msg.tick}, peak size ${msg.peak_size}.`);
        break;
      case "round_end": {
        const top = msg.standings[0];
        console.log(`Round ${msg.round} ended. Winner: ${top?.display_name} (peak ${top?.peak_size}).`);
        break;
      }
    }
  });
}

main();
