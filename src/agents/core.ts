import { WebSocket } from "ws";

/**
 * Shared agent core: the protocol types and the connection/run loop used by every
 * agent brain (the LLM client and the programmatic baseline).
 *
 * A "brain" is just a function that, given the current observation and the round's
 * server-provided rules, returns a move. The run loop owns everything else —
 * authentication, auto-reconnect, the per-tick deadline, and telemetry — so the
 * brains stay small and directly comparable under identical conditions.
 *
 * FAIRNESS CONTRACT: this module imports NOTHING from the server/engine source
 * (only `ws`) and uses ONLY fields the server documents (`state.*`, `rules.*`).
 */

export type Direction = "up" | "down" | "left" | "right";
export type Cell = { x: number; y: number };

export interface SnakeView {
  /** True length of the enemy (not just the visible portion). */
  length: number;
  head: Cell;
  body: Cell[];
}

export interface Food {
  x: number;
  y: number;
  value: number;
}

/** The round's rules, exactly as the server announces them. */
export interface Rules {
  id: string;
  name: string;
  brief: string;
  objective: "survive" | "grow" | "kills" | "zone" | "relay" | "bell" | "fasting";
  food: "normal" | "scarce" | "feast";
  food_grows?: boolean;
  poison_value?: number;
  zone?: { x: number; y: number; w: number; h: number };
  waypoints?: { x: number; y: number }[];
  bell_tick?: number;
  /** Extra twists layered on the base card this round (may be empty/absent). */
  modifiers?: { id: string; name: string; brief: string }[];
}

export interface State {
  tick: number;
  action_deadline_ms: number;
  world: { width: number; height: number };
  vision?: { center_x: number; center_y: number; radius: number };
  you: {
    heading: Direction;
    head: Cell;
    length: number;
    body: Cell[];
    combo?: number;
    frenzy_ticks_left?: number;
    ghost_ticks_left?: number;
    flare_ticks_left?: number;
    magnet_ticks_left?: number;
    zone_ticks?: number;
    waypoints_done?: number;
    next_waypoint?: Cell | null;
  };
  food: Food[];
  obstacles: Cell[];
  power_ups: Array<{ x: number; y: number; kind: string }>;
  snakes: SnakeView[];
}

export const INTENTS = ["feeding", "hunting", "evading", "escaping", "roaming"] as const;
export type Intent = (typeof INTENTS)[number];

export interface Decision {
  move: Direction | null;
  intent: Intent | null;
  target: string | null;
  /** Brain-specific telemetry merged into the action log (e.g. prompt, raw model
   * text for the LLM; move analysis for the programmatic baseline). */
  log?: Record<string, unknown>;
}

export interface Brain {
  /** Recorded as `model` in telemetry and shown on connect. */
  name: string;
  /** One-line human description for the connect banner. */
  banner: string;
  decide(state: State, rules: Rules | null, signal: AbortSignal): Decision | Promise<Decision>;
}

/** Connect to the arena and play with the given brain, reconnecting on drop. */
export function runAgent(brain: Brain): void {
  const key = process.argv[2] ?? process.env.AGENT_KEY ?? "local-dev-key";
  const arenaUrl = process.argv[3] ?? process.env.ARENA_URL ?? "ws://localhost:8080";

  // Auto-reconnect with exponential backoff so a transient drop doesn't remove
  // the agent from the benchmark. A 401 (bad key) is fatal — no point retrying.
  const MIN_BACKOFF = 1000;
  const MAX_BACKOFF = 30_000;
  let backoff = MIN_BACKOFF;

  const connect = (): void => {
    const ws = new WebSocket(`${arenaUrl}/agent`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    let inFlight: AbortController | null = null;
    let rules: Rules | null = null;

    ws.on("open", () => {
      backoff = MIN_BACKOFF;
      console.log(`Connected to ${arenaUrl}; ${brain.banner}`);
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
      inFlight?.abort();
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      console.log(`Disconnected (code ${code}). Reconnecting in ${Math.round(delay / 1000)}s…`);
      setTimeout(connect, delay);
    });

    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "round_start") {
        if (msg.rules) rules = msg.rules as Rules;
        console.log(`Round ${msg.round} started — rules: ${rules ? rules.name : "classic"}.`);
        return;
      }
      if (msg.type === "dead") {
        console.log(`Died at tick ${msg.tick}, peak size ${msg.peak_size}.`);
        return;
      }
      if (msg.type === "round_end") {
        const top = msg.standings[0];
        let line = `Round ${msg.round} ended. Winner: ${top?.display_name} (peak ${top?.peak_size}).`;
        if (msg.your) {
          const y = msg.your;
          const d = y.rating_delta > 0 ? `+${y.rating_delta}` : `${y.rating_delta}`;
          line += ` You: #${y.rank}/${y.field_size}, quality ${y.decision_quality}, rating ${Math.round(y.rating ?? 0)} (${d}).`;
          if (y.intent_rate != null) line += ` Intent ${y.intent_rate}% declared, ${y.intent_coherent_rate}% coherent.`;
        }
        console.log(line);
        return;
      }
      if (msg.type !== "state") return;

      const state = msg.state as State;
      // The arena echoes the active rules on every state too; keep ours fresh so a
      // mid-round (re)connect still plays to the correct objective.
      if (msg.rules) rules = msg.rules as Rules;

      // Cancel any previous (now stale) request and bound this one by the deadline.
      inFlight?.abort();
      const ac = new AbortController();
      inFlight = ac;
      const budget = Math.max(500, state.action_deadline_ms - Date.now() - 100);
      const timer = setTimeout(() => ac.abort(), budget);

      const started = Date.now();
      try {
        const decision = await brain.decide(state, rules, ac.signal);
        clearTimeout(timer);
        const move = decision.move;
        if (move && ws.readyState === WebSocket.OPEN) {
          const latencyMs = Date.now() - started;
          ws.send(
            JSON.stringify({
              type: "action",
              tick: state.tick,
              move,
              intent: decision.intent,
              target: decision.target,
              log: {
                model: brain.name,
                latencyMs,
                intent: decision.intent,
                target: decision.target,
                ...decision.log,
              },
            }),
          );
          console.log(
            `tick ${state.tick}: ${move}/${decision.intent ?? "—"} (${latencyMs}ms, len ${state.you.length})`,
          );
        }
      } catch (err) {
        clearTimeout(timer);
        if (!ac.signal.aborted) console.error("model error:", (err as Error).message);
      }
    });
  };

  connect();
}
