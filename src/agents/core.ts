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
  /** Dynamics-changing "laws" in force this round, in natural language (may be
   * empty/absent). Each has a machine `kind`, a short `title`, and a prose `brief`.
   * Laws with a board location also carry it (cadence `anchor`/`every`, confine `rect`). */
  laws?: {
    kind: string;
    title: string;
    brief: string;
    anchor?: { x: number; y: number };
    every?: number;
    rect?: { x: number; y: number; w: number; h: number };
  }[];
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
    zone_ticks?: number;
    waypoints_done?: number;
    next_waypoint?: Cell | null;
    /** This agent's own recent moves (oldest first) and whether each was legal —
     * `move` is "none" when it timed out; `legal` is false for a rejected
     * (illegal neck-reversal) move. Server-provided short-term memory. */
    recent_moves?: { tick: number; move: Direction | "none"; legal: boolean }[];
  };
  food: Food[];
  obstacles: Cell[];
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

/** Everything a brain gets for one decision. The server is the environment: it
 * sends the INFORMATION to play — the structured `state` and the structured
 * `rules` (objective + laws). Turning that into a model prompt is the brain's
 * job; the server does no prompting. */
export interface Observation {
  state: State;
  rules: Rules | null;
  signal: AbortSignal;
}

export interface Brain {
  /** Recorded as `model` in telemetry and shown on connect. */
  name: string;
  /** One-line human description for the connect banner. */
  banner: string;
  decide(obs: Observation): Decision | Promise<Decision>;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** Reconnect if no message (including heartbeats) arrives for this long. The
 * server heartbeats every 25s, so this tolerates a couple of misses. It also
 * comfortably exceeds the per-tick think ceiling, so a slow model is never
 * dropped mid-decision. */
const DEAD_MS = 80_000;
/** How often the liveness watchdog checks the last-activity clock. */
const WATCH_INTERVAL_MS = 5_000;

function arenaHttpOrigin(arenaUrl: string): string {
  const wsBase = arenaUrl.replace(/\/$/, "");
  const httpBase = wsBase.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  const u = new URL(httpBase.includes("://") ? httpBase : `http://${httpBase}`);
  return `${u.protocol}//${u.host}`;
}

/** Wake a cold-hosted arena before opening the WebSocket (best effort). */
async function wakeArena(arenaUrl: string): Promise<void> {
  const origin = arenaHttpOrigin(arenaUrl);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${origin}/healthz`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      /* server may still be waking */
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error("send failed:", (err as Error).message);
  }
}

/** Connect to the arena and play with the given brain, reconnecting on drop. */
export function runAgent(brain: Brain): void {
  const key = process.argv[2] ?? process.env.AGENT_KEY ?? "local-dev-key";
  const arenaUrl = process.argv[3] ?? process.env.ARENA_URL ?? "ws://localhost:8080";

  // --- connection state: deliberately minimal ------------------------------
  // One socket, one backoff, one "last time we heard anything" clock, and one
  // watchdog. There is NO separate handshake state machine and NO per-message
  // gating: any inbound message keeps the connection alive, and `welcome` simply
  // logs that the session is ready. This is the whole connection design.
  let ws: WebSocket | null = null;
  let backoff = MIN_BACKOFF_MS;
  let fatalAuth = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = 0;
  let inFlight: AbortController | null = null;
  let rules: Rules | null = null;

  const scheduleReconnect = (): void => {
    if (fatalAuth || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    console.log(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void boot();
    }, delay);
  };

  /** Decide and submit a move for one tick, bounded by the server's deadline. */
  const submitMove = async (state: State): Promise<void> => {
    if (!ws || Date.now() > state.action_deadline_ms) return;
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;
    const budget = Math.max(500, state.action_deadline_ms - Date.now() - 100);
    const timer = setTimeout(() => ac.abort(), budget);
    const started = Date.now();
    try {
      const decision = await brain.decide({ state, rules, signal: ac.signal });
      clearTimeout(timer);
      const move = decision.move;
      if (move && ws && ws.readyState === WebSocket.OPEN) {
        const latencyMs = Date.now() - started;
        sendJson(ws, {
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
        });
        console.log(
          `tick ${state.tick}: ${move}/${decision.intent ?? "—"} (${latencyMs}ms, len ${state.you.length})`,
        );
      }
    } catch (err) {
      clearTimeout(timer);
      if (!ac.signal.aborted) console.error("model error:", (err as Error).message);
    }
  };

  /** Route one decoded message. The socket-level `message` handler has already
   * recorded liveness, so this only reacts to the few types we act on. */
  const handle = (msg: { type?: string; [key: string]: unknown }): void => {
    switch (msg.type) {
      case "welcome":
        backoff = MIN_BACKOFF_MS;
        console.log(`Session ready (${String(msg.you_id ?? "agent")}). ${brain.banner}`);
        return;
      case "round_start":
        if (msg.rules) rules = msg.rules as Rules;
        console.log(`Round ${msg.round} started — rules: ${rules ? rules.name : "classic"}.`);
        return;
      case "queued": {
        const pos = msg.position != null ? `#${msg.position}` : "pending";
        const total = msg.queued != null ? ` of ${msg.queued}` : "";
        console.log(
          `Queued for round ${msg.round} (${pos}${total}, cap ${msg.cap}, ${msg.reason ?? "waiting"}).`,
        );
        return;
      }
      case "dead":
        console.log(`Died at tick ${msg.tick}, peak size ${msg.peak_size}.`);
        return;
      case "round_end": {
        const top = (msg.standings as { display_name?: string; peak_size?: number }[] | undefined)?.[0];
        let line = `Round ${msg.round} ended. Winner: ${top?.display_name} (peak ${top?.peak_size}).`;
        const y = msg.your as
          | {
              rank?: number;
              field_size?: number;
              decision_quality?: number;
              rating?: number;
              rating_delta?: number;
              intent_rate?: number;
              intent_coherent_rate?: number;
            }
          | undefined;
        if (y) {
          const d = (y.rating_delta ?? 0) > 0 ? `+${y.rating_delta}` : `${y.rating_delta ?? 0}`;
          line += ` You: #${y.rank}/${y.field_size}, quality ${y.decision_quality}, rating ${Math.round(y.rating ?? 0)} (${d}).`;
          if (y.intent_rate != null) {
            line += ` Intent ${y.intent_rate}% declared, ${y.intent_coherent_rate}% coherent.`;
          }
        }
        console.log(line);
        return;
      }
      case "state":
        // The arena echoes the active rules on every state; keep ours fresh so a
        // mid-round (re)connect still plays to the correct objective.
        if (msg.rules) rules = msg.rules as Rules;
        void submitMove(msg.state as State);
        return;
      // sync / heartbeat / leaderboard / spectator frames: liveness only.
      default:
        return;
    }
  };

  const connect = (): void => {
    if (fatalAuth) return;
    inFlight?.abort();
    lastActivity = Date.now();
    const sock = new WebSocket(`${arenaUrl}/agent`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    ws = sock;

    sock.on("open", () => {
      if (sock !== ws) return;
      lastActivity = Date.now();
      console.log(`Connected to ${arenaUrl}; waiting for session… (${brain.banner})`);
    });

    sock.on("message", (raw) => {
      if (sock !== ws) return;
      lastActivity = Date.now();
      let msg: { type?: string; [key: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handle(msg);
    });

    sock.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        fatalAuth = true;
        console.error("Authentication failed (401) — check your AGENT_KEY. Not retrying.");
        process.exit(1);
      }
      console.error(`Handshake rejected: HTTP ${res.statusCode}`);
      try { sock.close(); } catch { /* ignore */ }
    });

    sock.on("error", (err) => console.error("WS error:", err.message));

    sock.on("close", (code) => {
      if (sock !== ws) return;
      ws = null;
      inFlight?.abort();
      if (fatalAuth) return;
      // 4005 = replaced by a newer connection for this account: retry promptly.
      if (code === 4005) backoff = MIN_BACKOFF_MS;
      console.log(`Disconnected (code ${code}).`);
      scheduleReconnect();
    });
  };

  // The one and only liveness check: if a socket exists but nothing has arrived
  // for DEAD_MS, drop it and let `close` schedule a reconnect.
  const watchdog = setInterval(() => {
    if (!ws || fatalAuth) return;
    if (Date.now() - lastActivity > DEAD_MS) {
      console.warn("No messages from arena — reconnecting.");
      try { ws.close(); } catch { /* ignore */ }
    }
  }, WATCH_INTERVAL_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  const boot = async (): Promise<void> => {
    await wakeArena(arenaUrl);
    if (fatalAuth) return;
    connect();
  };

  void boot();
}
