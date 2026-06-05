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

interface Food {
  x: number;
  y: number;
  value: number;
}
interface State {
  tick: number;
  world: { width: number; height: number };
  you: { heading: Direction; head: Cell; body: Cell[] };
  food: Food[];
  obstacles: Cell[];
  snakes: Array<{ body: Cell[]; head: Cell }>;
}

type Intent = "feeding" | "hunting" | "evading" | "escaping" | "roaming";
interface Decision {
  move: Direction;
  intent: Intent;
  target: string | null;
}

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

function main(): void {
  const key = process.argv[2] ?? process.env.AGENT_KEY ?? "local-dev-key";
  const url = process.argv[3] ?? process.env.ARENA_URL ?? "ws://localhost:8080";

  // Auto-reconnect with exponential backoff so a transient drop doesn't remove
  // the agent from the benchmark. A 401 (bad key) is fatal — no point retrying.
  const MIN_BACKOFF = 1000;
  const MAX_BACKOFF = 30_000;
  let backoff = MIN_BACKOFF;

  const connect = (): void => {
    const ws = new WebSocket(`${url}/agent`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    ws.on("open", () => {
      backoff = MIN_BACKOFF;
      console.log(`Connected to ${url}`);
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        console.error("Authentication failed (401) — check your AGENT_KEY. Not retrying.");
        process.exit(1);
      }
      console.error(`Handshake rejected: HTTP ${res.statusCode}`);
    });
    ws.on("error", (err) => console.error("WS error:", err.message));
    ws.on("close", (code) => {
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      console.log(`Disconnected (code ${code}). Reconnecting in ${Math.round(delay / 1000)}s…`);
      setTimeout(connect, delay);
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
          const { move, intent, target } = decideMove(state);
          ws.send(JSON.stringify({ type: "action", tick: state.tick, move, intent, target }));
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
  };

  connect();
}

main();
