import { runAgent, type Decision, type Observation, type Rules, type State } from "./core.js";
import { ReasoningTracer, isControlRemap } from "./reasoning-trace.js";

/**
 * LLM brain (text-only). The SERVER is the environment: it sends the information
 * to play — the structured `state` and the structured `rules` (objective + laws).
 * THIS HARNESS does the prompting: it tells the model what it is doing and its
 * goal, lays out the current rules/laws and its situation as plain facts, and
 * asks for a single move. It does NOT tell the model how to handle situations —
 * working out the right move from the facts is the model's job, which is the
 * whole point of the benchmark.
 *
 * The model is served via an OpenAI-compatible API. By default this points at a
 * local llama.cpp (turboquant) server running Qwen3.6 on port 8081 — start it
 * with `npm run serve:llm`. Override the endpoint with arg/LLAMA_URL and the
 * label with LLAMA_MODEL.
 *
 * Usage: npm run agent:llm -- [key] [arenaUrl] [llamaUrl]
 */

// Served by the local llama.cpp server (run-llama.ps1) on port 8081. llama-server
// serves whatever single model it was launched with, so MODEL_NAME is only a
// label for the banner/telemetry. Override the endpoint with arg/LLAMA_URL.
const LLAMA_URL = process.argv[4] ?? process.env.LLAMA_URL ?? "http://localhost:8081";
const MODEL_NAME = process.env.LLAMA_MODEL ?? "Qwen3.6";

/** What the model is doing and how to answer — framing only, no strategy. */
const SYSTEM_PROMPT = [
  "You are an autonomous agent controlling ONE snake in a real-time grid game (SnakeBench).",
  "Each turn you are given the current round's rules and win condition plus your situation as structured facts. Coordinates: North is up; x grows east (right), y grows south (down). Positions of nearby things are given as (Δx,Δy) offsets from your head, where +Δx is east and +Δy is south.",
  "Movement: one cell per turn — up, down, left or right. ILLEGAL means your TRAVEL direction (after any control-remap law) would enter your neck cell — the engine ignores it and you waste the turn. Your current heading is your last travel direction; it is not necessarily a legal submission, especially under remap laws.",
  "Control-remap laws (rotate/mirror): the direction you SUBMIT is converted to the direction you TRAVEL before the move applies. Decide the travel direction you want (stay off your neck, walls, rivals), then submit the input the law maps onto that travel. The law brief gives the mapping; your answer is the SUBMITTED direction, not the travel direction. Submitting the same word as your heading is often wrong under remap.",
  "Keep reasoning brief: state desired travel, derive the submission under remap if any, confirm travel avoids your neck, then answer. Do not re-list every entity, re-copy the full law text, or run multiple verification passes.",
  "Answer with EXACTLY one line: '<direction> <intent>' where direction is up, down, left or right and intent is one of feeding, hunting, evading, escaping, roaming. You may append a few words naming a target after the intent. Do not explain.",
].join(" ");

/** A token-friendly, strategy-free statement of the current facts. */
function describeSituation(state: State, rules: Rules | null): string {
  const you = state.you;
  const lines: string[] = [];

  if (rules) {
    lines.push(`Round "${rules.name}": ${rules.brief}`);
    lines.push(`Win condition (objective): ${rules.objective}.`);
    const econ = [`food density ${rules.food}`];
    if (rules.food_grows === false) econ.push("eating food gives NO growth this round");
    if (rules.poison_value != null) econ.push(`food worth ${rules.poison_value}+ is poison (lethal)`);
    lines.push(`${econ.join("; ")}.`);
    if (rules.zone) {
      lines.push(`Scoring zone: x ${rules.zone.x}..${rules.zone.x + rules.zone.w - 1}, y ${rules.zone.y}..${rules.zone.y + rules.zone.h - 1}.`);
    }
    if (rules.waypoints?.length) {
      lines.push(`Waypoints in order: ${rules.waypoints.map((w) => `(${w.x},${w.y})`).join(" -> ")}.`);
    }
    if (rules.bell_tick != null) {
      lines.push(`This round ends at tick ${rules.bell_tick}; whatever the standings are then is final.`);
    }
    if (rules.modifiers?.length) {
      lines.push("Twists in play:");
      for (const m of rules.modifiers) lines.push(`- ${m.brief}`);
    }
    if (rules.laws?.length) {
      lines.push("LAWS IN FORCE (these change how moving works — read carefully):");
      for (const l of rules.laws) lines.push(`- ${l.brief}`);
    }
  }

  lines.push(`Deciding for tick ${state.tick}.`);

  lines.push(
    `Board ${state.world.width}x${state.world.height} (origin top-left). You are at (${you.head.x},${you.head.y}), heading ${you.heading} (your last travel direction), length ${you.length}.`,
  );
  if (you.body.length >= 2) {
    const neck = you.body[1]!;
    lines.push(
      `Your neck is at (${neck.x},${neck.y}). TRAVEL into that cell is ILLEGAL — under remap laws, check the travel direction your submission becomes, not whether it matches heading.`,
    );
  }
  const walls = [
    `west ${you.head.x}`,
    `east ${state.world.width - 1 - you.head.x}`,
    `north ${you.head.y}`,
    `south ${state.world.height - 1 - you.head.y}`,
  ];
  lines.push(`Cells to each wall: ${walls.join(", ")}.`);

  // Nearby entities as relative offsets (Δx east+, Δy south+), so the model has
  // exact coordinates as well as the picture. Facts only.
  const rel = (c: { x: number; y: number }) => `(${c.x - you.head.x >= 0 ? "+" : ""}${c.x - you.head.x},${c.y - you.head.y >= 0 ? "+" : ""}${c.y - you.head.y})`;
  if (state.food.length) {
    const items = [...state.food]
      .sort((a, b) => Math.abs(a.x - you.head.x) + Math.abs(a.y - you.head.y) - (Math.abs(b.x - you.head.x) + Math.abs(b.y - you.head.y)))
      .slice(0, 12)
      .map((f) => `${rel(f)}v${f.value}`);
    lines.push(`Food (Δ from you, value): ${items.join(", ")}.`);
  }
  if (state.snakes.length) {
    const items = state.snakes
      .slice(0, 8)
      .map((s) => `head ${rel(s.head)} len${s.length}`);
    lines.push(`Other snakes: ${items.join("; ")}.`);
  }
  if (state.obstacles.length) {
    const items = [...state.obstacles]
      .sort((a, b) => Math.abs(a.x - you.head.x) + Math.abs(a.y - you.head.y) - (Math.abs(b.x - you.head.x) + Math.abs(b.y - you.head.y)))
      .slice(0, 12)
      .map((o) => rel(o));
    lines.push(`Obstacles (Δ from you): ${items.join(", ")}.`);
  }
  const progress: string[] = [];
  if (rules?.objective === "zone") progress.push(`zone_ticks ${you.zone_ticks ?? 0}`);
  if (rules?.objective === "relay") progress.push(`waypoints_done ${you.waypoints_done ?? 0}`);
  if (progress.length) lines.push(`Objective progress: ${progress.join(", ")}.`);

  // Your own recent moves and how the engine treated them. ILLEGAL = travel into
  // neck (often after remap); the engine ignores it and you keep heading.
  if (you.recent_moves?.length) {
    const hist = you.recent_moves
      .map((m) =>
        m.move === "none"
          ? `t${m.tick} none (timed out)`
          : `t${m.tick} ${m.move}${m.legal ? "" : " (ILLEGAL, ignored)"}`,
      )
      .join(", ");
    lines.push(`Your recent moves (oldest first): ${hist}.`);
  }

  lines.push("Your move?");
  return lines.join("\n");
}

const tracer = new ReasoningTracer(MODEL_NAME);

async function askModel(obs: Observation): Promise<Decision> {
  // First, reconcile the server's legality verdicts for our earlier moves (it
  // reports them a tick late) against the reasoning that produced them.
  tracer.noteOutcomes(obs.state.you.recent_moves);

  const text = describeSituation(obs.state, obs.rules);

  // Text-only: the model reasons purely from the structured facts.
  const content: unknown[] = [{ type: "text", text }];

  const started = Date.now();
  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: obs.signal,
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0,
      // Reasoning stays ON — the point of the benchmark is the model reasoning
      // about novel laws. We do not cap tokens or otherwise constrain it.
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const message = data.choices?.[0]?.message ?? {};
  const rawContent = message.content ?? "";

  // Separate the chain-of-thought from the answer. llama-server either splits it
  // into `reasoning_content` or leaves it inline as <think>…</think>; handle both.
  // Parsing the move from the answer (not the reasoning) also avoids matching a
  // direction word the model merely mentioned while thinking.
  let reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  let answer = rawContent;
  const think = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
  if (think) {
    if (!reasoning) reasoning = (think[1] ?? "").trim();
    answer = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  const parseSrc = answer || rawContent;
  const lower = parseSrc.toLowerCase();
  const move = (lower.match(/\b(up|down|left|right)\b/)?.[1] as Decision["move"]) ?? null;
  const intent = (lower.match(/\b(feeding|hunting|evading|escaping|roaming)\b/)?.[1] as Decision["intent"]) ?? null;
  let target: string | null = null;
  if (intent) {
    const after = parseSrc.slice(lower.indexOf(intent) + intent.length).trim();
    if (after) target = after.replace(/\s+/g, " ").slice(0, 24);
  }

  tracer.record({
    tick: obs.state.tick,
    round: obs.rules?.name ?? null,
    laws: obs.rules?.laws ?? [],
    controlRemap: isControlRemap(obs.rules?.laws),
    heading: obs.state.you.heading,
    head: obs.state.you.head,
    move,
    intent,
    target,
    reasoning,
    answer: parseSrc,
    prompt: text,
    latencyMs: Date.now() - started,
  });

  return { move, intent, target, log: { prompt: text, response: rawContent, reasoning } };
}

runAgent({
  name: MODEL_NAME,
  banner: `brain=llm, model=${MODEL_NAME} at ${LLAMA_URL}`,
  decide: (obs) => askModel(obs),
});
