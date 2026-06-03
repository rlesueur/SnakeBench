import { WebSocket } from "ws";

/**
 * LLM agent. Connects to the arena, and each tick asks a local llama.cpp server
 * (OpenAI-compatible API) which way to move, passing the vision-scoped state
 * straight into the prompt.
 *
 * Requires a running llama-server, e.g.:
 *   llama-server.exe -m Qwen3.6-35B-A3B-UD-Q6_K.gguf --port 8081 -ngl 999 --jinja
 *
 * Usage: npm run agent:llm -- [key] [arenaUrl] [llamaUrl]
 */
type Direction = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };

interface SnakeView {
  head: Cell;
  body: Cell[];
}
interface Food {
  x: number;
  y: number;
  value: number;
}
interface State {
  tick: number;
  action_deadline_ms: number;
  world: { width: number; height: number };
  you: { heading: Direction; head: Cell; length: number; body: Cell[] };
  food: Food[];
  obstacles: Cell[];
  power_ups: Array<{ x: number; y: number; kind: string }>;
  snakes: SnakeView[];
}

const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};
const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

const SYSTEM_PROMPT = [
  "You play a grid snake game. You see a local map centred on your head '@'.",
  "Legend: @ your head, o your body, X enemy snake, . empty, # wall or obstacle (out-of-bounds and deadly).",
  "Food: * = +1 growth, $ = +3, & = +6 (rarer, more valuable). F = frenzy power-up (briefly doubles food).",
  "Moving onto #, o, or X KILLS you. Eat food to grow longer.",
  "Your goal is to survive and become the longest snake. Prefer higher-value food when safe.",
  "Reply with ONLY one word: up, down, left, or right.",
].join(" ");

const LLAMA_URL = process.argv[4] ?? process.env.LLAMA_URL ?? "http://localhost:8081";
const MAP_RADIUS = 6;

function buildMap(state: State): string {
  const { head } = state.you;
  const occ = new Map<string, string>();
  for (const o of state.obstacles ?? []) occ.set(`${o.x},${o.y}`, "#");
  for (const c of state.you.body.slice(1)) occ.set(`${c.x},${c.y}`, "o");
  for (const s of state.snakes) for (const c of s.body) occ.set(`${c.x},${c.y}`, "X");
  for (const p of state.power_ups ?? []) occ.set(`${p.x},${p.y}`, "F");
  for (const f of state.food) {
    occ.set(`${f.x},${f.y}`, f.value >= 6 ? "&" : f.value >= 3 ? "$" : "*");
  }
  occ.set(`${head.x},${head.y}`, "@");

  const rows: string[] = [];
  for (let dy = -MAP_RADIUS; dy <= MAP_RADIUS; dy++) {
    let row = "";
    for (let dx = -MAP_RADIUS; dx <= MAP_RADIUS; dx++) {
      const x = head.x + dx;
      const y = head.y + dy;
      if (x < 0 || x >= state.world.width || y < 0 || y >= state.world.height) {
        row += "#";
      } else {
        row += occ.get(`${x},${y}`) ?? ".";
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function describeMoves(state: State): string {
  const { head, heading, body } = state.you;
  const banned = body.length > 1 ? OPPOSITE[heading] : null;
  const blocked = new Set<string>();
  for (const c of body) blocked.add(`${c.x},${c.y}`);
  for (const s of state.snakes) for (const c of s.body) blocked.add(`${c.x},${c.y}`);
  for (const o of state.obstacles ?? []) blocked.add(`${o.x},${o.y}`);

  const lines = DIRECTIONS.map((d) => {
    if (d === banned) return `${d}: ILLEGAL (would reverse)`;
    const n = { x: head.x + DELTA[d].x, y: head.y + DELTA[d].y };
    const oob = n.x < 0 || n.x >= state.world.width || n.y < 0 || n.y >= state.world.height;
    if (oob || blocked.has(`${n.x},${n.y}`)) return `${d}: DEADLY`;
    return `${d}: safe`;
  });

  let foodHint = "No food in sight.";
  if (state.food.length) {
    let best = state.food[0]!;
    let bestD = Infinity;
    for (const f of state.food) {
      const dist = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
      if (dist < bestD) {
        bestD = dist;
        best = f;
      }
    }
    const dx = best.x - head.x;
    const dy = best.y - head.y;
    const hor = dx > 0 ? "right" : dx < 0 ? "left" : "";
    const ver = dy > 0 ? "down" : dy < 0 ? "up" : "";
    foodHint = `Nearest food is ${[ver, hor].filter(Boolean).join(" and ")} (${bestD} steps).`;
  }
  return `${lines.join("\n")}\n${foodHint}`;
}

interface ModelDecision {
  move: Direction | null;
  prompt: string;
  raw: string;
}

async function askModel(state: State, signal: AbortSignal): Promise<ModelDecision> {
  const user =
    `Map (you are @ in the centre):\n${buildMap(state)}\n\n` +
    `Move options:\n${describeMoves(state)}\n\n` +
    `Choose a safe move towards food. Answer with one word.`;

  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: "local",
      temperature: 0,
      max_tokens: 4,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const m = raw.toLowerCase().match(/\b(up|down|left|right)\b/);
  return { move: (m?.[1] as Direction) ?? null, prompt: user, raw };
}

function main(): void {
  const key = process.argv[2] ?? process.env.AGENT_KEY ?? "local-dev-key";
  const arenaUrl = process.argv[3] ?? process.env.ARENA_URL ?? "ws://localhost:8080";
  const ws = new WebSocket(`${arenaUrl}/agent?key=${encodeURIComponent(key)}`);

  let inFlight: AbortController | null = null;

  ws.on("open", () => console.log(`Connected to ${arenaUrl}; model at ${LLAMA_URL}`));
  ws.on("error", (err) => console.error("WS error:", err.message));
  ws.on("close", () => {
    console.log("Disconnected.");
    process.exit(0);
  });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "round_start") {
      console.log(`Round ${msg.round} started.`);
      return;
    }
    if (msg.type === "dead") {
      console.log(`Died at tick ${msg.tick}, peak size ${msg.peak_size}.`);
      return;
    }
    if (msg.type === "round_end") {
      const top = msg.standings[0];
      console.log(`Round ${msg.round} ended. Winner: ${top?.display_name} (peak ${top?.peak_size}).`);
      return;
    }
    if (msg.type !== "state") return;

    const state = msg.state as State;

    // Cancel any previous (now stale) request and bound this one by the deadline.
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;
    const budget = Math.max(500, state.action_deadline_ms - Date.now() - 100);
    const timer = setTimeout(() => ac.abort(), budget);

    const started = Date.now();
    try {
      const decision = await askModel(state, ac.signal);
      clearTimeout(timer);
      const move = decision.move;
      if (move && ws.readyState === WebSocket.OPEN) {
        const latencyMs = Date.now() - started;
        ws.send(
          JSON.stringify({
            type: "action",
            tick: state.tick,
            move,
            log: {
              model: "qwen3.6-local",
              latencyMs,
              system: SYSTEM_PROMPT,
              prompt: decision.prompt,
              response: decision.raw,
            },
          }),
        );
        console.log(`tick ${state.tick}: ${move} (${latencyMs}ms, len ${state.you.length})`);
      }
    } catch (err) {
      clearTimeout(timer);
      if (!ac.signal.aborted) console.error("model error:", (err as Error).message);
    }
  });
}

main();
