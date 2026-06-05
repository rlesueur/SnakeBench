import { runAgent, type Decision, type Rules, type State } from "./core.js";

/**
 * LLM brain — a THIN client. Each tick it relays the SERVER's own rule description
 * plus the raw local observation into the prompt and asks a local llama.cpp server
 * (OpenAI-compatible API) for a move.
 *
 * It does NO tactical analysis and embeds NO game strategy of its own: what each
 * card / objective / modifier means comes from the server's brief, and working out
 * which move is safe or on-objective is left entirely to the model. That is the
 * whole point of the benchmark — we measure the MODEL's reasoning, not the client's
 * heuristics, so the client must never pre-chew the decision.
 *
 * Requires a running llama-server, e.g.:
 *   llama-server.exe -m Qwen3.6-35B-A3B-UD-Q6_K.gguf --port 8081 -ngl 999 --jinja
 *
 * Usage: npm run agent:llm -- [key] [arenaUrl] [llamaUrl]
 */

const LLAMA_URL = process.argv[4] ?? process.env.LLAMA_URL ?? "http://localhost:8081";
const MODEL_NAME = process.env.LLAMA_MODEL ?? "qwen3.6-local";
const MAP_RADIUS_CAP = 30; // safety cap on the rendered window

/** Single-letter map glyph per power-up kind (the agent's own rendering choice). */
const POWER_GLYPH: Record<string, string> = {
  frenzy: "F", ghost: "G", flare: "L", magnet: "M", wall: "K",
};

const SYSTEM_PROMPT = [
  "You are an agent playing a grid-based snake game over an API.",
  "Each turn you receive the rules in force for the current round and a local view of the board centred on your snake's head, and you choose a single move.",
  "Map symbols: @ your head, o your own body, X another snake, # wall or obstacle, . empty cell, ? a cell outside your view. Food shows its value: * is 1, $ is 3, & is 6. The letters F, G, L, M, K are power-ups.",
  "Fixed rules of the game: you move one cell per turn in the direction you choose and may not immediately reverse into your own neck; moving into a wall, an obstacle, or any snake (including yourself) ends your run. The round's rules below may add their own win condition and twists.",
  "Read the round's rules and the board, then decide the move that best serves the win condition — that is your job to work out.",
  "Reply with exactly: '<direction> <intent>' where direction is up, down, left or right and intent is one of feeding, hunting, evading, escaping, roaming. You may add a few words naming a target after the intent.",
].join(" ");

/** Render the transmitted vision as an ASCII map centred on the head. This is just
 * a faithful drawing of the observation the server sent — no analysis. */
function buildMap(state: State): string {
  const { head } = state.you;
  const radius = Math.min(state.vision?.radius ?? 12, MAP_RADIUS_CAP);
  const occ = new Map<string, string>();
  for (const o of state.obstacles ?? []) occ.set(`${o.x},${o.y}`, "#");
  for (const c of state.you.body.slice(1)) occ.set(`${c.x},${c.y}`, "o");
  for (const s of state.snakes) for (const c of s.body) occ.set(`${c.x},${c.y}`, "X");
  for (const p of state.power_ups ?? []) occ.set(`${p.x},${p.y}`, POWER_GLYPH[p.kind] ?? "P");
  for (const f of state.food) {
    occ.set(`${f.x},${f.y}`, f.value >= 6 ? "&" : f.value >= 3 ? "$" : "*");
  }
  occ.set(`${head.x},${head.y}`, "@");

  const rows: string[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    let row = "";
    for (let dx = -radius; dx <= radius; dx++) {
      const x = head.x + dx;
      const y = head.y + dy;
      if (x < 0 || x >= state.world.width || y < 0 || y >= state.world.height) {
        row += "#";
      } else if (Math.abs(dx) + Math.abs(dy) > radius) {
        row += "?"; // outside the transmitted vision diamond
      } else {
        row += occ.get(`${x},${y}`) ?? ".";
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Build the per-tick prompt: the server's rules for this round, then the raw
 * observation. No move analysis, no food ranking, no objective coaching — the
 * model is given the same information a human reading the rules would have. */
function buildPrompt(state: State, rules: Rules | null): string {
  const you = state.you;
  const lines: string[] = [];

  if (rules) {
    lines.push(`Rules this round — "${rules.name}": ${rules.brief}`);
    lines.push(`Win condition (objective): ${rules.objective}.`);
    const econ = [`food density: ${rules.food}`];
    if (rules.food_grows === false) econ.push("eating food does not make you grow this round");
    if (rules.poison_value != null) econ.push(`poison_value: ${rules.poison_value}`);
    lines.push(`${econ.join("; ")}.`);
    if (rules.zone) {
      lines.push(
        `zone: x ${rules.zone.x}..${rules.zone.x + rules.zone.w - 1}, y ${rules.zone.y}..${rules.zone.y + rules.zone.h - 1}.`,
      );
    }
    if (rules.waypoints?.length) {
      lines.push(`waypoints (in order): ${rules.waypoints.map((w) => `(${w.x},${w.y})`).join(" -> ")}.`);
    }
    if (rules.bell_tick != null) lines.push(`bell_tick: ${rules.bell_tick}.`);
    if (rules.modifiers?.length) {
      lines.push("Twists in play:");
      for (const m of rules.modifiers) lines.push(`- ${m.brief}`);
    }
    lines.push("");
  }

  lines.push(
    `Board: ${state.world.width} wide x ${state.world.height} tall; origin (0,0) is top-left, x grows right (east), y grows down (south). It is tick ${state.tick}.`,
  );
  lines.push("Map (you are @ at the centre, north is up):");
  lines.push(buildMap(state));
  lines.push("");

  const status = [
    `position (${you.head.x}, ${you.head.y})`,
    `length ${you.length}`,
    `heading ${you.heading}`,
  ];
  if (you.zone_ticks != null) status.push(`zone_ticks ${you.zone_ticks}`);
  if (you.waypoints_done != null) status.push(`waypoints_done ${you.waypoints_done}`);
  if (you.next_waypoint) status.push(`next_waypoint (${you.next_waypoint.x}, ${you.next_waypoint.y})`);
  const effects: string[] = [];
  if (you.combo && you.combo > 1) effects.push(`combo x${you.combo}`);
  if (you.frenzy_ticks_left) effects.push(`frenzy ${you.frenzy_ticks_left}`);
  if (you.ghost_ticks_left) effects.push(`ghost ${you.ghost_ticks_left}`);
  if (you.flare_ticks_left) effects.push(`flare ${you.flare_ticks_left}`);
  if (you.magnet_ticks_left) effects.push(`magnet ${you.magnet_ticks_left}`);
  if (effects.length) status.push(`active power-ups: ${effects.join(", ")}`);
  lines.push(`You: ${status.join(", ")}.`);
  lines.push("");
  lines.push("Your move? Reply '<direction> <intent>' (intent: feeding, hunting, evading, escaping, roaming), optionally a short target.");

  return lines.join("\n");
}

async function askModel(state: State, rules: Rules | null, signal: AbortSignal): Promise<Decision> {
  const user = buildPrompt(state, rules);

  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: "local",
      temperature: 0,
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
  const lower = raw.toLowerCase();
  // Take the FIRST direction word (the model answers "<direction> <intent>").
  const move = (lower.match(/\b(up|down|left|right)\b/)?.[1] as Decision["move"]) ?? null;
  const intent = (lower.match(/\b(feeding|hunting|evading|escaping|roaming)\b/)?.[1] as Decision["intent"]) ?? null;
  // Anything after the intent word is treated as a short free-text target.
  let target: string | null = null;
  if (intent) {
    const after = raw.slice(lower.indexOf(intent) + intent.length).trim();
    if (after) target = after.replace(/\s+/g, " ").slice(0, 24);
  }
  return { move, intent, target, log: { system: SYSTEM_PROMPT, prompt: user, response: raw } };
}

runAgent({
  name: MODEL_NAME,
  banner: `brain=llm, model at ${LLAMA_URL}`,
  decide: (state, rules, signal) => askModel(state, rules, signal),
});
