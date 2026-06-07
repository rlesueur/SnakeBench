import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_SERVER_CONFIG,
  type GameConfig,
  type ServerConfig,
} from "../config.js";
import { Game, type SnakeSpec } from "../engine/game.js";
import { Rng } from "../rng.js";
import { NPC_REGISTRY, NPC_ANCHOR, type NpcKind } from "../npc/bots.js";
import { DIRECTIONS, DELTA, type Direction, type Cell, type Snake, cellKey } from "../types.js";
import { analyseMove, type MoveContext, SPACE_CAP } from "../engine/decision-quality.js";
import { expandStandings, DEFAULT_RATING, DEFAULT_RD } from "../rating/glicko2.js";
import { buildAgentView, type RecentMove } from "./view.js";
import { pickRuleCard, rollModifiers, rollLaws, foodMultiplier, type RuleCard, type Modifier } from "../rules/cards.js";
import { type Law, applyTransform } from "../engine/laws.js";
import { parseIntent, sanitiseTarget, type Intent } from "./intent.js";
import { fullSnapshot, staticMap, type SpectatorFrame } from "./snapshot.js";
import { roundDecisionQuality } from "./stats.js";
import type { StatsStore, RoundEntry, RoundQuality } from "./stats.js";
import type { LogStore } from "./logs.js";

export interface AgentSession {
  /** Stable snake id for this connection (used across rounds). */
  snakeId: string;
  displayName: string;
  send: (msg: unknown) => void;
  pendingMove: Direction | null;
  alive: boolean;
  /** Last vision view sent, with its tick and send time (for decision logs). */
  lastView: unknown;
  lastViewTick: number;
  lastSentAt: number;
  /** Last tick we persisted a decision log for, so a flood of action messages
   * within a single tick cannot amplify into many DB writes. */
  lastLoggedTick?: number;
  /** Optional short, agent-supplied rationale for its latest move (untrusted,
   * kept for the decision log only). */
  lastNote?: string | null;
  /** The agent's declared intent for its latest move (validated enum, untrusted). */
  lastIntent?: Intent | null;
  /** The agent's optional sanitised free-text target for its latest move. */
  lastTarget?: string;
  /** Server-measured latency (ms) of the most recent action: time from sending
   * the state to receiving the move. */
  lastLatencyMs?: number | null;
  /** This agent's last few {tick, move, legal} results, fed back in each state so
   * the model has short-term memory of what it did. Reset each round. */
  recentMoves?: RecentMove[];
}

export interface ArenaHooks {
  broadcastSpectators: (msg: unknown) => void;
}

const VALID_MOVES = new Set<string>(DIRECTIONS);

/** How many of an agent's most recent moves to feed back to it each tick. */
const RECENT_MOVES_CAP = 10;

/** A live, server-authoritative read on an agent's latest move, for commentary.
 * `kind` classifies the move; `text` is a short human-readable summary; `says`
 * is the agent's own (untrusted) rationale if it supplied one. */
/** Compact rule-card description sent to spectators and agents. */
export interface RulesPayload {
  id: string;
  name: string;
  brief: string;
  objective: string;
  food: string;
  /** False on "carnivore" rounds where food gives no growth. */
  food_grows: boolean;
  /** Food at/above this value is lethal poison this round, if set. */
  poison_value?: number;
  /** "zone" objective: the scoring region (board coordinates), if any. */
  zone?: { x: number; y: number; w: number; h: number };
  /** "relay" objective: the ordered waypoint cells, if any. */
  waypoints?: { x: number; y: number }[];
  /** "bell" objective: the tick the round ends and length is judged, if any. */
  bell_tick?: number;
  /** Extra twists layered on the base card this round (may be empty). */
  modifiers: { id: string; name: string; brief: string }[];
  /** Dynamics-changing "laws" in force this round, described in natural language
   * (may be empty). These reshape how a move is interpreted, which moves are
   * legal, or what cells mean — the agent must read and reason about them.
   * Laws with a board location also carry it structurally (e.g. a cadence law's
   * `anchor` beacon, a confine law's `rect`) so clients can mark it. */
  laws: {
    kind: string;
    title: string;
    brief: string;
    anchor?: { x: number; y: number };
    every?: number;
    rect?: { x: number; y: number; w: number; h: number };
  }[];
}

type NoteKind = "safe" | "risky" | "blunder" | "timeout" | "illegal";
interface AgentNote {
  id: string;
  name: string;
  kind: NoteKind;
  text: string;
  /** Structured, varying telemetry for the spectator overlay. */
  move?: Direction | null;
  len?: number;
  /** Reachable free space after the move (capped). */
  space?: number;
  /** Enemy heads within striking distance (varies as snakes converge). */
  threats?: number;
  /** The agent's own declared intent this tick (validated enum). */
  intent?: Intent | null;
  /** The agent's optional sanitised free-text target. */
  target?: string;
  /** Whether the declared intent is coherent with the board (server check). */
  intentOk?: boolean;
}

/** Per-agent, per-round accumulator for server-authoritative decision quality. */
interface QualityAcc {
  moves: number;
  legal: number;
  timeouts: number;
  safeOpp: number;
  safeChosen: number;
  spaceSum: number;
  lastSafeAlt: boolean;
  avoidableDeath: boolean;
  latencySum: number;
  latencyCount: number;
  /** Moves on which the agent declared a valid intent. */
  intentDeclared: number;
  /** Declared-intent moves that were coherent with the board (server check). */
  intentCoherent: number;
  /** Moves made while one or more laws were in force this round. */
  lawMoves: number;
  /** Law-round moves on which a safe, lawful option existed. */
  lawSafeOpp: number;
  /** ...of those, moves where the (law-aware) chosen move was safe and lawful.
   * The ratio is the agent's law-comprehension rate: did it move correctly once
   * the round's prose changed the dynamics? A baseline that ignores the laws
   * scores far below its lawless safe-rate. */
  lawSafeChosen: number;
}

/** Maximum serialised size of decision-log evidence we will persist (16 KB).
 * Larger payloads are dropped so an authenticated agent cannot bloat the DB. */
const MAX_EVIDENCE_BYTES = 16 * 1024;

/** Minimum tick denominator for food efficiency, so a snake that grabs a feast
 * and dies immediately cannot post a perfect growth-per-tick rate. */
const FOOD_TICK_FLOOR = 50;
function capEvidence(evidence: unknown): unknown {
  if (evidence == null) return null;
  let serialised: string;
  try {
    serialised = JSON.stringify(evidence);
  } catch {
    return { truncated: true, reason: "unserialisable" };
  }
  if (serialised.length > MAX_EVIDENCE_BYTES) {
    return { truncated: true, reason: "too_large", bytes: serialised.length };
  }
  return evidence;
}

/**
 * Hosts a continuously running arena: rounds of SnakeBench played in
 * real time. Connected agents control their own snakes; the lobby is backfilled
 * with NPCs up to a minimum size so a round is always watchable.
 */
export class Arena {
  private readonly config: GameConfig;
  private readonly serverConfig: ServerConfig;
  private readonly hooks: ArenaHooks;
  private readonly stats: StatsStore | null;
  private readonly logs: LogStore | null;

  private readonly agents = new Map<string, AgentSession>();
  private game: Game | null = null;
  private npc = new Map<string, { kind: NpcKind; rng: Rng }>();
  private round = 0;
  private roundActive = false;
  /** Whether this round started with at least one real agent. */
  private roundHasAgents = false;
  /** snakeId -> account for the agents in the current round (kept across drops). */
  private roundAccounts = new Map<string, string>();
  /** Agents that connected but were not placed last round (over the per-round
   * cap). They get priority entry into the next round for fairness. */
  private queuedLastRound = new Set<string>();
  /** snakeId -> decision-quality accumulator for the agents in this round. */
  private roundQuality = new Map<string, QualityAcc>();
  /** snakeId -> latest server-authoritative move assessment, for spectators. */
  private liveNotes = new Map<string, AgentNote>();
  /** snakeId -> kills tally for the current round (for round-end highlights). */
  private roundKills = new Map<string, { name: string; kills: number }>();
  /** The rule card in force for the current round (objective, head-to-head, food). */
  private roundCard: RuleCard = pickRuleCard("init");
  private roundMods: Modifier[] = [];
  /** Natural-language "laws" in force this round (dynamics-changing rules). */
  private roundLaws: Law[] = [];
  /** Alive-snake count last tick, and the tick it last changed (stall detection). */
  private lastAlive = 0;
  private lastAliveChangeTick = 0;
  /** Current tick interval, so we only recreate the timer when it changes. */
  private currentTickMs = 0;
  /** When the current decision window opened (ms since epoch). Cleared on resolve. */
  private deliberationStartedAt = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Grace window after the first agent joins an ambient lobby, so a burst of
   * agents arriving together all start in the same round. */
  private joinTimer: NodeJS.Timeout | null = null;
  private frames: SpectatorFrame[] = [];
  private readonly baseSeed: string;

  constructor(
    hooks: ArenaHooks,
    config = DEFAULT_CONFIG,
    serverConfig = DEFAULT_SERVER_CONFIG,
    stats: StatsStore | null = null,
    logs: LogStore | null = null,
  ) {
    this.config = config;
    this.serverConfig = serverConfig;
    this.hooks = hooks;
    this.stats = stats;
    this.logs = logs;
    this.baseSeed = `arena-${Date.now()}`;
  }

  /** All-time benchmark leaderboard (empty if no stats store configured). */
  leaderboard(): unknown[] {
    return this.stats ? this.stats.leaderboard() : [];
  }

  /** A single account's stats row (works even outside the top-N board). */
  statRow(account: string): unknown {
    return this.stats ? this.stats.rowFor(account) : null;
  }

  start(): void {
    this.startRound();
  }

  stop(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.tickTimer = null;
    this.restartTimer = null;
    this.joinTimer = null;
  }

  getConfig(): GameConfig {
    return this.config;
  }

  /** Build a spectator frame tagged with the round's objective and kill tally, so
   * each snake's live `score` reflects how this round is actually won. */
  private snapshotNow(game: Game): SpectatorFrame {
    return fullSnapshot(game, {
      objective: this.roundCard.objective,
      killsOf: (id) => this.roundKills.get(id)?.kills ?? 0,
    });
  }

  /** Latest full frame + static map, for a spectator that just connected. */
  currentFrame():
    | {
        round: number;
        world: { width: number; height: number };
        obstacles: ReturnType<typeof staticMap>["obstacles"];
        frame: SpectatorFrame;
        rules: RulesPayload;
        deliberation: ReturnType<Arena["currentDeliberation"]>;
      }
    | null {
    if (!this.game) return null;
    return {
      round: this.round,
      world: { width: this.game.config.width, height: this.game.config.height },
      obstacles: staticMap(this.game).obstacles,
      frame: this.snapshotNow(this.game),
      rules: this.rulesPayload(),
      deliberation: this.currentDeliberation(),
    };
  }

  /** Snapshot of an open agent decision window, for spectators joining mid-tick. */
  currentDeliberation():
    | {
        tick: number;
        ceiling_ms: number;
        started_at: number;
        agents: Array<{ id: string; name: string }>;
        locked: string[];
      }
    | null {
    if (!this.game || !this.roundActive || !this.deliberationStartedAt) return null;
    const agents: Array<{ id: string; name: string }> = [];
    const locked: string[] = [];
    for (const snake of this.game.aliveSnakes()) {
      const session = this.agents.get(snake.id);
      if (!session) continue;
      agents.push({ id: snake.id, name: session.displayName });
      if (session.pendingMove) locked.push(snake.id);
    }
    if (agents.length === 0) return null;
    return {
      tick: this.game.tick,
      ceiling_ms: this.currentTickMs,
      started_at: this.deliberationStartedAt,
      agents,
      locked,
    };
  }

  // --- agent membership ----------------------------------------------------

  /**
   * True only when this agent currently has a live snake in an ongoing round.
   * Agents waiting between rounds (queued mid-round, or defeated and awaiting
   * the next round) return false, so they are never idle-disconnected.
   */
  isAgentLiveInRound(snakeId: string): boolean {
    if (!this.roundActive || !this.game) return false;
    if (!this.agents.has(snakeId)) return false;
    return this.game.snakeById(snakeId)?.alive === true;
  }

  addAgent(session: AgentSession): void {
    const wasEmpty = this.agents.size === 0;
    this.agents.set(session.snakeId, session);

    // Between rounds: the pending (or initial) startRound will include them.
    if (!this.roundActive) return;

    // A player round is already running: queue them for the next round rather
    // than disrupting the live match (24/7 fairness). But if the current round
    // is an ambient NPC-only game, start a fresh player round after a short
    // grace window so a burst of agents arriving together all join the same
    // round (rather than the first one starting a lonely solo round).
    if (wasEmpty) {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      if (!this.joinTimer) {
        this.joinTimer = setTimeout(() => {
          this.joinTimer = null;
          this.startRound();
        }, this.serverConfig.joinGraceMs);
      }
    }
  }

  removeAgent(snakeId: string): void {
    this.agents.delete(snakeId);
    // Their snake (if any) simply continues on its last heading until it dies.
  }

  submitAction(
    snakeId: string,
    tick: number,
    move: string,
    evidence: unknown = null,
    note: string | null = null,
    intent: unknown = null,
    target: unknown = null,
  ): void {
    if (!this.roundActive || !this.game) return;
    const session = this.agents.get(snakeId);
    if (!session) return;
    if (tick !== this.game.tick) return; // stale action
    if (!VALID_MOVES.has(move)) return;
    const firstThisTick = session.pendingMove === null;
    session.pendingMove = move as Direction;
    // Let spectators tick this snake over to "locked in" for the live beat (once
    // per tick — a resubmit just updates the move, not the lock-in state).
    if (firstThisTick) {
      this.hooks.broadcastSpectators({ type: "locked_in", id: snakeId, tick });
    }
    // Server-measured decision latency for this move (state-sent -> action-in).
    session.lastLatencyMs = session.lastSentAt ? Date.now() - session.lastSentAt : null;
    // Keep a short, sanitised rationale for the decision log only (untrusted).
    session.lastNote = note ? note.replace(/\s+/g, " ").trim().slice(0, 120) : null;
    // Validate the agent's declared intent (enum) and sanitise its free-text
    // target — both untrusted. Invalid intent is recorded as "undeclared".
    session.lastIntent = parseIntent(intent);
    session.lastTarget = sanitiseTarget(target);

    // Persist at most one decision log per tick. An agent may legitimately
    // resubmit (the last move wins, above), but only the first accepted action
    // for a tick is logged so a message flood cannot bloat the database.
    if (this.logs && session.lastLoggedTick !== tick) {
      session.lastLoggedTick = tick;
      this.logs.append({
        ts: Date.now(),
        round: this.round,
        tick,
        account: session.displayName,
        snakeId,
        move,
        intent: session.lastIntent,
        target: session.lastTarget ?? null,
        latencyMs: session.lastSentAt ? Date.now() - session.lastSentAt : null,
        view: session.lastViewTick === tick ? session.lastView : null,
        evidence: capEvidence(evidence),
      });
    }

    // Adaptive cadence: if this was the last agent we were waiting on, resolve
    // the tick now instead of idling until the ceiling.
    this.maybeResolveEarly();
  }

  /** Dynamic play-area: bigger worlds for more snakes, to keep density sane. */
  private worldForPlayers(n: number): { width: number; height: number; foodTarget: number } {
    const side = Math.min(
      260,
      Math.max(56, Math.round(Math.sqrt(Math.max(1, n) * this.serverConfig.cellsPerSnake))),
    );
    return { width: side, height: side, foodTarget: Math.round(side * side * 0.01) };
  }

  // --- round lifecycle -----------------------------------------------------

  /** Safe entry point: a failed round start (e.g. an impossible roster) must
   * never crash the arena — log it and retry rather than throwing out of a
   * timer callback. */
  private startRound(): void {
    try {
      this.beginRound();
    } catch (err) {
      console.error(`Round start failed (round ~${this.round + 1}); retrying shortly:`, err);
      this.roundActive = false;
      this.game = null;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.startRound(), this.serverConfig.roundRestartDelayMs);
    }
  }

  private beginRound(): void {
    if (this.joinTimer) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    this.round += 1;
    const seed = `${this.baseSeed}-r${this.round}`;

    // Apply the per-round agent cap. Agents queued last round get priority, so
    // nobody is starved when more agents are connected than a round can hold.
    const all = [...this.agents.values()];
    const cap = Math.max(1, this.serverConfig.maxAgentsPerRound);
    const prioritised = [
      ...all.filter((s) => this.queuedLastRound.has(s.snakeId)),
      ...all.filter((s) => !this.queuedLastRound.has(s.snakeId)),
    ];
    const playing = prioritised.slice(0, cap);
    const queued = prioritised.slice(cap);
    this.queuedLastRound = new Set(queued.map((s) => s.snakeId));

    const specs: SnakeSpec[] = [];
    this.roundAccounts = new Map();
    this.roundQuality = new Map();
    this.liveNotes = new Map();
    this.roundKills = new Map();
    for (const session of playing) {
      specs.push({ id: session.snakeId, displayName: session.displayName, isNpc: false });
      this.roundAccounts.set(session.snakeId, session.displayName);
      this.roundQuality.set(session.snakeId, {
        moves: 0,
        legal: 0,
        timeouts: 0,
        safeOpp: 0,
        safeChosen: 0,
        spaceSum: 0,
        lastSafeAlt: false,
        avoidableDeath: false,
        latencySum: 0,
        latencyCount: 0,
        intentDeclared: 0,
        intentCoherent: 0,
        lawMoves: 0,
        lawSafeOpp: 0,
        lawSafeChosen: 0,
      });
      session.pendingMove = null;
      session.alive = true;
      session.recentMoves = [];
    }
    // Queued agents sit this round out (no snake); mark them not-alive so the
    // tick loop and idle handling treat them as waiting for the next round.
    for (const session of queued) {
      session.pendingMove = null;
      session.alive = false;
    }
    if (queued.length) {
      console.log(`Round ${this.round}: ${playing.length} agents playing, ${queued.length} queued (cap ${cap}).`);
    }

    this.npc = new Map();
    const { minSnakes, npcFloor, npcBackfill } = this.serverConfig;
    // NPCs fill the lobby up to minSnakes when few agents are online, then taper
    // to a small anchor floor as more real players join.
    const agentCount = specs.length;
    this.roundHasAgents = agentCount > 0;
    const npcCount = Math.max(npcFloor, minSnakes - agentCount);
    const target = agentCount + npcCount;
    let i = 0;
    while (specs.length < target) {
      const kind = npcBackfill[i % npcBackfill.length] as NpcKind;
      const id = `npc_${kind}_${i + 1}`;
      specs.push({ id, displayName: `npc_${kind}`, isNpc: true });
      this.npc.set(id, { kind, rng: new Rng(`${seed}:${id}`) });
      i += 1;
    }

    // Ambient (no real agents) rounds run faster and end sooner so the attract
    // loop keeps cycling; agent rounds use the full deadline and length.
    const ambient = !this.roundHasAgents;
    const tickMs = ambient ? this.serverConfig.ambientTickMs : this.config.tickDeadlineMs;
    const maxTicks = ambient ? this.serverConfig.ambientMaxTicks : this.config.maxTicks;

    // Draw the rule card for this round (seeded, deterministic) and apply its
    // mechanical effects: head-to-head rule and food availability.
    const card = pickRuleCard(seed);
    this.roundCard = card;
    const mods = rollModifiers(seed);
    this.roundMods = mods;

    // Size the play-area to the number of snakes in this round. Combat cards pack
    // the board tighter (boardScale < 1) to force the encounters that make kills
    // possible; clamp so even a tight board still fits every (longer) spawn.
    const dims = this.worldForPlayers(specs.length);
    const startingLength = card.startingLength ?? this.config.startingLength;
    const scale = card.boardScale ?? 1;
    const minSide = Math.max(50, Math.ceil(Math.sqrt(specs.length * (startingLength + 8) * 4)));
    const width = Math.max(minSide, Math.round(dims.width * scale));
    const height = Math.max(minSide, Math.round(dims.height * scale));
    // Vision scales with the board so rivals are actually visible to hunt — a fixed
    // radius on a large board left snakes blind to each other. Clamped so it stays
    // a partial-observability task on big boards and the payload stays sane.
    const visionRadius = Math.max(18, Math.min(64, Math.round(Math.max(width, height) * 0.34)));
    // Base economy/combat from the card, then layer each modifier's overrides.
    let foodScale = foodMultiplier(card.foodMod);
    let lengthTaxTicks = card.lengthTaxTicks ?? this.config.lengthTaxTicks;
    let cutoffAbsorbFraction = card.cutoffAbsorbFraction ?? this.config.cutoffAbsorbFraction;
    let carcassFoodValue = card.carcassFoodValue ?? this.config.carcassFoodValue;
    let poisonValue = card.poisonValue;
    for (const m of mods) {
      if (m.foodMultiplier != null) foodScale *= m.foodMultiplier;
      if (m.lengthTaxTicks != null) lengthTaxTicks = m.lengthTaxTicks;
      if (m.cutoffAbsorbFraction != null) cutoffAbsorbFraction = m.cutoffAbsorbFraction;
      if (m.carcassFoodValue != null) carcassFoodValue = m.carcassFoodValue;
      if (m.poisonValue != null) poisonValue = m.poisonValue;
    }
    // Keep food density roughly constant when the board is rescaled.
    const areaScale = (width * height) / (dims.width * dims.height);
    const foodTarget = Math.max(20, Math.round(dims.foodTarget * areaScale * foodScale));

    // Generate the round's spatial / timed objective from the seed, so positions
    // and timing differ every round and can't be hard-coded by an agent.
    const orng = new Rng(`obj:${seed}`);
    const margin = 5;
    let scoreZone: GameConfig["scoreZone"];
    let waypoints: GameConfig["waypoints"];
    let bellTick: number | undefined;
    if (card.objective === "zone") {
      const zw = Math.max(8, Math.round(width * 0.22));
      const zh = Math.max(8, Math.round(height * 0.22));
      scoreZone = {
        x: margin + orng.int(Math.max(1, width - zw - 2 * margin)),
        y: margin + orng.int(Math.max(1, height - zh - 2 * margin)),
        w: zw,
        h: zh,
      };
    } else if (card.objective === "relay") {
      const count = 6 + orng.int(5);
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < count; i++) {
        pts.push({
          x: margin + orng.int(Math.max(1, width - 2 * margin)),
          y: margin + orng.int(Math.max(1, height - 2 * margin)),
        });
      }
      waypoints = pts;
    } else if (card.objective === "bell") {
      bellTick = Math.min(maxTicks, ambient ? Math.round(maxTicks * 0.7) : 120 + orng.int(120));
    }
    // Every agent round gets a hard turn limit (a "bell"), not just the bell card.
    // Because a round now runs until EVERY agent is out, a lone snake that simply
    // never dies could otherwise keep a round going indefinitely. Reaching the
    // limit ends the round and it is scored exactly as it stands (by the round's
    // own objective). The randomized tick can't be hard-coded by an agent. Ambient
    // (NPC-only) rounds already cap out via ambientMaxTicks, so they keep that.
    if (!ambient && bellTick == null) {
      bellTick = Math.min(maxTicks, 120 + orng.int(120));
    }
    const effectiveMaxTicks = bellTick ?? maxTicks;

    // Roll the round's "laws" (dynamics-changing rules). Spatial parameters are
    // sized to the final board, so they vary every round and can't be hard-coded.
    const laws = rollLaws(seed, width, height);
    this.roundLaws = laws;

    const roundConfig = {
      ...this.config,
      width,
      height,
      foodTarget,
      visionRadius,
      headToHead: this.config.headToHead,
      startingLength,
      foodGrows: card.foodGrows ?? true,
      poisonValue,
      scoreZone,
      waypoints,
      bellTick,
      lengthTaxTicks,
      cutoffAbsorbFraction,
      carcassFoodValue,
      tickDeadlineMs: tickMs,
      maxTicks: effectiveMaxTicks,
      laws,
    };

    this.game = Game.create(specs, seed, roundConfig);
    // Special prizes (e.g. golden apple) spawn after the board is built.
    for (const m of mods) {
      if (m.specialFood) this.game.addSpecialFood(m.specialFood.value, m.specialFood.count);
    }
    this.frames = [this.snapshotNow(this.game)];
    this.roundActive = true;
    this.lastAlive = specs.length;
    this.lastAliveChangeTick = 0;

    const world = { width, height };
    const obstacles = staticMap(this.game).obstacles;
    const rules = this.rulesPayload();
    for (const session of playing) {
      session.send({
        type: "round_start",
        round: this.round,
        you_id: session.snakeId,
        world,
        obstacles,
        tick_deadline_ms: tickMs,
        rules,
      });
    }
    // Tell queued agents they are waiting, with their position in the queue.
    queued.forEach((session, idx) => {
      session.send({
        type: "queued",
        round: this.round,
        position: idx + 1,
        queued: queued.length,
        cap,
        reason: "round_full",
      });
    });
    this.hooks.broadcastSpectators({ type: "round_start", round: this.round, world, obstacles, rules });
    // Show the starting board immediately. Without this the spectator sits blank
    // through the whole first decision window (now up to the full ceiling), with
    // nothing for the thinking overlay to attach to.
    this.hooks.broadcastSpectators({
      type: "frame",
      frame: this.snapshotNow(this.game),
      events: [],
      notes: [],
    });

    // Open the first decision window and arm its ceiling. Subsequent windows are
    // armed at the end of each resolveTick. `tickMs` is the *ceiling*, not a fixed
    // wait: the window resolves as soon as every live agent has locked in.
    this.currentTickMs = tickMs;
    this.sendStateToAgents();
    this.broadcastDeliberation();
    this.armTick();
  }

  /** Arm the ceiling timer for the current decision window. The window will
   * resolve at this deadline at the latest, or earlier via maybeResolveEarly. */
  private armTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => this.resolveTick(), this.currentTickMs);
  }

  /** Tell spectators a new decision window has opened: which agent snakes are
   * thinking and the ceiling they have to answer within. This drives the live
   * "deliberating / locked-in" beat. Skipped for ambient (NPC-only) windows. */
  private broadcastDeliberation(): void {
    if (!this.game) return;
    const agents: Array<{ id: string; name: string }> = [];
    const locked: string[] = [];
    for (const snake of this.game.aliveSnakes()) {
      const session = this.agents.get(snake.id);
      if (session) {
        agents.push({ id: snake.id, name: session.displayName });
        if (session.pendingMove) locked.push(snake.id);
      }
    }
    if (agents.length === 0) return;
    this.deliberationStartedAt = Date.now();
    this.hooks.broadcastSpectators({
      type: "deliberation",
      tick: this.game.tick,
      ceiling_ms: this.currentTickMs,
      started_at: this.deliberationStartedAt,
      agents,
      locked,
    });
  }

  /** True once every *agent-controlled* live snake has submitted a move for this
   * tick. NPCs decide instantly at resolve so they never gate. Returns false for
   * a pure-NPC (ambient) round, which keeps the fixed ambient cadence. */
  private allLiveAgentsLockedIn(): boolean {
    if (!this.game) return false;
    let live = 0;
    for (const snake of this.game.aliveSnakes()) {
      const session = this.agents.get(snake.id);
      if (!session) continue;
      live += 1;
      if (!session.pendingMove) return false;
    }
    return live > 0;
  }

  /** Called after an agent submits: if all live agents are now locked in, resolve
   * the tick early rather than waiting out the ceiling. Scheduled on the next
   * macrotask so the submitting WS handler unwinds first, and guarded by nulling
   * the timer so concurrent submissions can't double-resolve. */
  private maybeResolveEarly(): void {
    if (!this.roundActive || this.tickTimer === null) return;
    if (!this.allLiveAgentsLockedIn()) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = null;
    setImmediate(() => this.resolveTick());
  }

  private resolveTick(): void {
    if (!this.roundActive || !this.game) return;
    this.deliberationStartedAt = 0;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    const game = this.game;

    const moves = new Map<string, Direction>();
    for (const snake of game.aliveSnakes()) {
      const agent = this.agents.get(snake.id);
      if (agent) {
        if (agent.pendingMove) moves.set(snake.id, agent.pendingMove);
        continue;
      }
      const npc = this.npc.get(snake.id);
      if (npc) {
        moves.set(snake.id, NPC_REGISTRY[npc.kind]!.decide(game, snake.id, npc.rng));
      }
    }

    this.recordDecisionQuality(game);

    const events = game.step(moves);

    // Tally head-to-head kills for round-end highlights.
    for (const e of events) {
      if (e.kind === "kill") {
        const k = this.roundKills.get(e.id) ?? { name: e.displayName, kills: 0 };
        k.kills += 1;
        this.roundKills.set(e.id, k);
      }
    }

    // Reset agent intents; a missed next tick means "continue current heading".
    for (const session of this.agents.values()) {
      session.pendingMove = null;
    }

    // Notify any agents whose snake just died.
    for (const session of this.agents.values()) {
      const snake = game.snakeById(session.snakeId);
      if (snake && !snake.alive && session.alive) {
        session.alive = false;
        // A death is "avoidable" if a safe move existed on the final decision.
        const acc = this.roundQuality.get(session.snakeId);
        if (acc && acc.lastSafeAlt) acc.avoidableDeath = true;
        session.send({ type: "dead", tick: game.tick, peak_size: snake.peakSize });
      }
    }

    // Track when the alive-snake count last changed, for stall detection.
    const aliveNow = game.aliveSnakes().length;
    if (aliveNow !== this.lastAlive) {
      this.lastAlive = aliveNow;
      this.lastAliveChangeTick = game.tick;
    }

    // Drop commentary for snakes that have died, so the overlay stays current.
    for (const id of [...this.liveNotes.keys()]) {
      if (!game.snakeById(id)?.alive) this.liveNotes.delete(id);
    }

    const frame = this.snapshotNow(game);
    this.frames.push(frame);
    this.hooks.broadcastSpectators({
      type: "frame",
      frame,
      events,
      notes: [...this.liveNotes.values()],
    });

    const reason = this.endReason(game);
    if (reason) {
      this.endRound(reason);
      return;
    }

    // Open the next decision window and arm its ceiling.
    this.sendStateToAgents();
    this.broadcastDeliberation();
    this.armTick();
  }

  /** Manhattan distance from a cell to the nearest food, or Infinity if none. */
  private nearestFoodDist(game: Game, c: Cell): number {
    let best = Infinity;
    for (const k of game.food.keys()) {
      const comma = k.indexOf(",");
      const fx = Number(k.slice(0, comma));
      const fy = Number(k.slice(comma + 1));
      const d = Math.abs(fx - c.x) + Math.abs(fy - c.y);
      if (d < best) {
        best = d;
        if (best <= 1) break;
      }
    }
    return best;
  }

  /**
   * Server-authoritative decision-quality sampling, run each tick *before* the
   * step using the move each agent actually submitted. Judges the move against
   * the real board (never the agent's self-reported evidence).
   */
  private recordDecisionQuality(game: Game): void {
    if (this.roundQuality.size === 0) return;
    // Body cells that persist next tick: every alive snake's body except its
    // tail (tails vacate). Shared across all agents this tick.
    const blocked = new Set<string>();
    const allHeads: Array<{ id: string; head: Cell; heading: Direction; length: number }> = [];
    for (const s of game.snakes) {
      if (!s.alive) continue;
      for (let i = 0; i < s.body.length - 1; i++) blocked.add(cellKey(s.body[i]!));
      allHeads.push({ id: s.id, head: s.body[0]!, heading: s.heading, length: s.body.length });
    }
    for (const [snakeId, acc] of this.roundQuality) {
      const snake = game.snakeById(snakeId);
      if (!snake || !snake.alive) continue;
      const session = this.agents.get(snakeId);
      const ctx: MoveContext = {
        width: game.config.width,
        height: game.config.height,
        obstacles: game.obstacles,
        blocked,
        head: snake.body[0]!,
        heading: snake.heading,
        submittedMove: session?.pendingMove ?? null,
        selfLength: snake.body.length,
        enemyHeads: allHeads
          .filter((h) => h.id !== snakeId)
          .map((h) => ({ head: h.head, heading: h.heading, length: h.length })),
        headToHead: this.config.headToHead,
        // Make the analysis law-aware so safe/blunder/avoidable-death reflect the
        // round's dynamics, not plain physics: a move is judged where the engine
        // will actually resolve it once transforms/constraints/inversion apply.
        laws: this.roundLaws,
        food: game.food,
        tick: game.tick,
      };
      const a = analyseMove(ctx);
      acc.moves += 1;
      if (a.legal) acc.legal += 1;
      if (a.timeout) acc.timeouts += 1;
      if (a.hadSafeAlternative) {
        acc.safeOpp += 1;
        if (a.choseSafe) acc.safeChosen += 1;
      }
      // Law-comprehension: the same safe-rate, but tallied only on rounds whose
      // dynamics were changed by a law. A reasoning agent keeps this near its
      // lawless safe-rate; a law-blind baseline collapses here.
      if (this.roundLaws.length) {
        acc.lawMoves += 1;
        if (a.hadSafeAlternative) {
          acc.lawSafeOpp += 1;
          if (a.choseSafe) acc.lawSafeChosen += 1;
        }
      }
      acc.spaceSum += a.spaceAfter;
      acc.lastSafeAlt = a.hadSafeAlternative;
      if (session?.pendingMove != null && session.lastLatencyMs != null) {
        acc.latencySum += session.lastLatencyMs;
        acc.latencyCount += 1;
      }

      // Server-authoritative move classification for the overlay colour (never
      // trusts the agent's own words for this).
      const move = session?.pendingMove ?? null;
      const head = snake.body[0]!;
      const len = snake.body.length;
      // Local pressure + nearest rival. Any rival is a potential cut-off target
      // (you kill by trapping them, not by out-sizing them), so the nearest enemy
      // head is the hunt target. Used for the overlay and the intent cross-check.
      let threats = 0;
      let nearestEnemy = Infinity;
      let huntCell: Cell | null = null;
      let huntDist = Infinity;
      for (const h of allHeads) {
        if (h.id === snakeId) continue;
        const d = Math.abs(h.head.x - head.x) + Math.abs(h.head.y - head.y);
        if (d <= 4) threats += 1;
        if (d < nearestEnemy) nearestEnemy = d;
        if (d < huntDist) {
          huntDist = d;
          huntCell = h.head;
        }
      }
      // Where the head will actually land: transform laws remap the submitted
      // direction, so feeding/hunting coherence is judged against the real cell.
      const effMove = move && this.roundLaws.length ? applyTransform(move, this.roundLaws) : move;
      const nh = effMove ? { x: head.x + DELTA[effMove].x, y: head.y + DELTA[effMove].y } : head;
      const foodNow = this.nearestFoodDist(game, head);
      const foodNext = move ? this.nearestFoodDist(game, nh) : foodNow;

      let kind: NoteKind;
      if (a.timeout) kind = "timeout";
      else if (!a.legal) kind = "illegal";
      else if (!a.choseSafe && a.hadSafeAlternative) kind = "blunder";
      else if (!a.choseSafe) kind = "risky";
      else kind = "safe";

      // Cross-check the agent's *declared* intent against the real board. We do
      // not act on the intent; this is purely a "does what it said match what it
      // did" reasoning signal, surfaced to spectators and the agent's summary.
      const declared = session?.lastIntent ?? null;
      let intentOk: boolean | undefined;
      if (declared) {
        switch (declared) {
          case "feeding":
            intentOk = foodNext < foodNow || foodNow === 0;
            break;
          case "hunting":
            intentOk = huntCell != null && Math.abs(nh.x - huntCell.x) + Math.abs(nh.y - huntCell.y) < huntDist;
            break;
          case "evading":
            intentOk = (threats > 0 || nearestEnemy <= 6) && a.choseSafe;
            break;
          case "escaping":
            intentOk = a.spaceAfter < Math.max(8, len * 2);
            break;
          case "roaming":
            intentOk = threats === 0;
            break;
        }
      }

      const room = `${a.spaceAfter}${a.spaceAfter >= SPACE_CAP ? "+" : ""}`;
      const fallback =
        kind === "timeout"
          ? `timed out — drifting ${snake.heading}`
          : kind === "illegal"
            ? `illegal move — held ${snake.heading}`
            : kind === "blunder"
              ? `${move} into danger — a safe move existed`
              : kind === "risky"
                ? `${move} — no safe move`
                : threats > 0
                  ? `${move} · ${threats} near · room ${room}`
                  : `${move} · room ${room}`;

      if (declared) {
        acc.intentDeclared += 1;
        if (intentOk) acc.intentCoherent += 1;
      }

      this.liveNotes.set(snakeId, {
        id: snakeId,
        name: snake.displayName,
        kind,
        text: fallback,
        move,
        len,
        space: a.spaceAfter,
        threats,
        intent: declared,
        target: session?.lastTarget,
        intentOk,
      });

      // Feed this move's result into the agent's own short-term memory: the next
      // state carries the last few {tick, move, legal} so the model can see when
      // a move was rejected as an illegal neck-reversal (or timed out).
      if (session) {
        (session.recentMoves ??= []).push({
          tick: game.tick,
          move: move ?? "none",
          legal: a.legal,
        });
        if (session.recentMoves.length > RECENT_MOVES_CAP) session.recentMoves.shift();
      }
    }
  }

  /** Number of currently-connected agents whose snake is still alive. */
  private aliveAgentCount(game: Game): number {
    let n = 0;
    for (const session of this.agents.values()) {
      const snake = game.snakeById(session.snakeId);
      if (snake && snake.alive) n += 1;
    }
    return n;
  }

  /** Decide whether (and why) the round should end this tick. */
  private endReason(game: Game): string | null {
    // Every round has a turn limit (maxTicks == its bell tick): on a "bell" round
    // that limit IS the win condition; on every other round it's the safety cap
    // that stops a never-dying snake dragging the round on forever. Either way the
    // round ends here and is scored exactly as it stands.
    if (game.tick >= game.config.maxTicks) {
      return this.roundCard.objective === "bell" ? "bell" : "time_limit";
    }
    const alive = game.aliveSnakes().length;
    if (alive === 0) return "all_dead";
    // Win condition reached: the relay is a race, so the first snake to complete
    // every waypoint wins and the round ends immediately, whoever reached it.
    if (this.roundCard.objective === "relay") {
      const total = game.config.waypoints?.length ?? 0;
      if (total > 0 && game.aliveSnakes().some((s) => s.waypointIndex >= total)) {
        return "objective_complete";
      }
    }
    if (this.roundHasAgents) {
      // A player round exists to measure the agents, so it runs until EVERY agent
      // is out — not the instant one is left standing. A lone surviving agent
      // keeps playing (and being scored) against any NPCs, or alone, until it
      // dies, the tick cap, or a stalemate. (NPCs still circling don't matter.)
      if (this.aliveAgentCount(game) === 0) return "agents_eliminated";
    } else if (alive === 1) {
      // Ambient attract round (NPCs only): end when one snake is left standing.
      return "last_standing";
    }
    // Stalemate: a few survivors circling without dying. End so the next round
    // can start rather than waiting out the full tick cap.
    if (alive <= 3 && game.tick - this.lastAliveChangeTick >= this.serverConfig.stallTicks) {
      return "stalemate";
    }
    return null;
  }

  /** Compact, machine-readable description of the active rule card, sent to
   * agents (so they can adapt) and spectators (so they can follow along). */
  private rulesPayload(): RulesPayload {
    const c = this.roundCard;
    const cfg = this.game?.config;
    return {
      id: c.id,
      name: c.name,
      brief: c.brief,
      objective: c.objective,
      food: c.foodMod,
      food_grows: cfg?.foodGrows ?? true,
      poison_value: cfg?.poisonValue,
      zone: cfg?.scoreZone,
      waypoints: cfg?.waypoints,
      bell_tick: cfg?.bellTick,
      modifiers: this.roundMods.map((m) => ({ id: m.id, name: m.name, brief: m.brief })),
      laws: this.roundLaws.map((l) => ({
        kind: l.kind,
        title: l.title,
        brief: l.brief,
        ...(l.kind === "cadence" ? { anchor: l.anchor, every: l.every } : {}),
        ...(l.kind === "confine" ? { rect: l.rect } : {}),
      })),
    };
  }

  private sendStateToAgents(): void {
    if (!this.game) return;
    const deadline = Date.now() + this.game.config.tickDeadlineMs;
    const rules = this.rulesPayload();
    for (const session of this.agents.values()) {
      const snake = this.game.snakeById(session.snakeId);
      if (!snake || !snake.alive) continue;
      const view = buildAgentView(this.game, session.snakeId, deadline, session.recentMoves ?? []);
      session.lastView = view;
      session.lastViewTick = this.game.tick;
      session.lastSentAt = Date.now();
      // The server is the environment: it sends the INFORMATION to play — the
      // structured vision-scoped `state` and the structured `rules` (objective +
      // laws). It does NOT prompt: turning this into a model prompt is the agent
      // harness's job.
      session.send({ type: "state", state: view, rules });
    }
  }

  private endRound(reason: string): void {
    if (!this.game) return;
    this.roundActive = false;
    this.deliberationStartedAt = 0;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Rank according to the round's rule card objective. Snakes still alive at
    // round end outrank those who died; remaining ties fall back to peak size.
    //  - survive: later death ranks higher.
    //  - grow:    largest peak length.
    //  - kills:   most cut-off kills.
    //  - zone:    most ticks spent inside the scoring zone.
    //  - relay:   most waypoints reached, in order.
    //  - bell:    alive and LONGEST at the bell tick.
    //  - fasting: survive long while staying SHORT (shortest wins).
    const objective = this.roundCard.objective;
    const endTick = this.game.tick;
    const deathOrder = (d: number | null): number => d ?? Number.POSITIVE_INFINITY;
    const killsOf = (id: string): number => this.roundKills.get(id)?.kills ?? 0;
    type Ranked = {
      snake: Snake;
      diedAtTick: number | null;
      peakSize: number;
      length: number;
      zoneTicks: number;
      waypoints: number;
      kills: number;
    };
    const ranked: Ranked[] = this.game.snakes.map((s) => ({
      snake: s,
      diedAtTick: s.diedAtTick,
      peakSize: s.peakSize,
      length: s.body.length,
      zoneTicks: s.zoneTicks,
      waypoints: s.waypointIndex,
      kills: killsOf(s.id),
    }));
    const aliveFirst = (a: Ranked, b: Ranked): number => deathOrder(b.diedAtTick) - deathOrder(a.diedAtTick);
    const comparator = (a: Ranked, b: Ranked): number => {
      switch (objective) {
        case "grow": return b.peakSize - a.peakSize || aliveFirst(a, b);
        case "kills": return b.kills - a.kills || aliveFirst(a, b) || b.peakSize - a.peakSize;
        case "zone": return b.zoneTicks - a.zoneTicks || aliveFirst(a, b) || b.peakSize - a.peakSize;
        case "relay": return b.waypoints - a.waypoints || aliveFirst(a, b) || b.peakSize - a.peakSize;
        case "bell": return aliveFirst(a, b) || b.length - a.length;
        case "fasting": return aliveFirst(a, b) || a.length - b.length;
        default: return aliveFirst(a, b) || b.peakSize - a.peakSize;
      }
    };
    const scoreOf = (r: Ranked): number => {
      switch (objective) {
        case "zone": return r.zoneTicks;
        case "relay": return r.waypoints;
        case "bell": return r.length;
        case "kills": return r.kills;
        case "grow": return r.peakSize;
        case "fasting": return r.length;
        default: return r.diedAtTick ?? endTick;
      }
    };
    ranked.sort(comparator);
    const standings = ranked.map((r, idx) => ({
      rank: idx + 1,
      id: r.snake.id,
      display_name: r.snake.displayName,
      is_npc: r.snake.isNpc,
      peak_size: r.peakSize,
      died_at_tick: r.diedAtTick,
      kills: r.kills,
      score: scoreOf(r),
    }));

    // Round-end highlights for spectators: the longest survivor (rank 1) and the
    // round's deadliest snake (most head-to-head kills), if any.
    const winner = standings[0];
    let topKiller: { name: string; kills: number } | null = null;
    for (const k of this.roundKills.values()) {
      if (!topKiller || k.kills > topKiller.kills) topKiller = { name: k.name, kills: k.kills };
    }
    const highlights = {
      survivor: winner
        ? { name: winner.display_name, ticks: winner.died_at_tick ?? this.game.tick, is_npc: winner.is_npc }
        : null,
      topKiller: topKiller && topKiller.kills > 0 ? topKiller : null,
    };

    this.hooks.broadcastSpectators({
      type: "round_end",
      round: this.round,
      reason,
      standings,
      highlights,
      rules: this.rulesPayload(),
      next_round_in_ms: this.serverConfig.roundRestartDelayMs,
    });

    // Per-snake round summary (quality + rank), returned to each agent below.
    const summary = new Map<
      string,
      { quality: RoundQuality; rank: number; fieldSize: number; intentRate: number; intentCoherentRate: number }
    >();
    const deltaByAccount = new Map<string, number>();

    // Persist per-account benchmark stats for the agent participants.
    if (this.stats) {
      const stats = this.stats;
      const game = this.game;
      const fieldSize = standings.length;
      const startingLength = this.config.startingLength;

      // Build the rating field: real agents at their current rating, NPCs at
      // their fixed anchor. Expand standings into pairwise Glicko-2 results.
      const ratingField = standings.map((s) => {
        if (s.is_npc) {
          const kind = this.npc.get(s.id)?.kind;
          const anchor = (kind && NPC_ANCHOR[kind]) || { rating: DEFAULT_RATING, rd: DEFAULT_RD };
          return { id: s.id, rank: s.rank, rating: anchor.rating, rd: anchor.rd };
        }
        const account = this.roundAccounts.get(s.id)!;
        const r = stats.getRating(account);
        return { id: s.id, rank: s.rank, rating: r.rating, rd: r.rd };
      });
      const pairwise = expandStandings(ratingField);

      const entries: RoundEntry[] = standings
        .filter((s) => !s.is_npc && this.roundAccounts.has(s.id))
        .map((s) => {
          const acc = this.roundQuality.get(s.id);
          const snake = game.snakeById(s.id);
          const survival = snake?.diedAtTick ?? game.tick;
          const growth = Math.max(0, (snake?.peakSize ?? startingLength) - startingLength);
          const quality: RoundQuality = {
            moves: acc?.moves ?? 0,
            legalRate: acc && acc.moves ? acc.legal / acc.moves : 1,
            safeRate: acc && acc.safeOpp ? acc.safeChosen / acc.safeOpp : 1,
            avoidableDeath: acc?.avoidableDeath ? 1 : 0,
            avgSpace: acc && acc.moves ? acc.spaceSum / acc.moves : 0,
            foodPerTick: growth / Math.max(survival, FOOD_TICK_FLOOR),
            timeoutRate: acc && acc.moves ? acc.timeouts / acc.moves : 0,
            survivalTicks: survival,
            latencyMs: acc && acc.latencyCount ? acc.latencySum / acc.latencyCount : 0,
            lawMoves: acc?.lawMoves ?? 0,
            // Law-aware safe-rate over law-round moves; null when this round had
            // no law (nothing to comprehend), so it never dilutes the average.
            lawComprehension:
              acc && acc.lawMoves ? (acc.lawSafeOpp ? acc.lawSafeChosen / acc.lawSafeOpp : 1) : null,
          };
          const intentRate = acc && acc.moves ? acc.intentDeclared / acc.moves : 0;
          const intentCoherentRate = acc && acc.intentDeclared ? acc.intentCoherent / acc.intentDeclared : 0;
          summary.set(s.id, { quality, rank: s.rank, fieldSize, intentRate, intentCoherentRate });
          return {
            account: this.roundAccounts.get(s.id)!,
            rank: s.rank,
            peakSize: s.peak_size,
            fieldSize,
            quality,
            ratingResults: pairwise.get(s.id) ?? [],
          };
        });
      if (entries.length) {
        // Snapshot conservative ratings before applying, to report the change.
        const before = new Map<string, number>();
        for (const e of entries) {
          const row = stats.rowFor(e.account);
          if (row) before.set(e.account, row.conservativeRating);
        }
        this.stats.recordRound(this.round, entries);
        const deltas = entries.map((e) => {
          const after = stats.rowFor(e.account)?.conservativeRating ?? 0;
          const prev = before.get(e.account);
          const delta = prev == null ? 0 : Math.round(after - prev);
          deltaByAccount.set(e.account, delta);
          return { account: e.account, delta };
        });
        const board = this.stats.leaderboard();
        for (const session of this.agents.values()) session.send({ type: "leaderboard", board, deltas });
        this.hooks.broadcastSpectators({ type: "leaderboard", board, deltas });
      }
    }

    // Return each agent its own round_end, enriched with a server-authoritative
    // breakdown of how it played (quality metrics + composite + rating change).
    for (const session of this.agents.values()) {
      const s = summary.get(session.snakeId);
      const account = session.displayName;
      const your = s
        ? {
            rank: s.rank,
            field_size: s.fieldSize,
            decision_quality: roundDecisionQuality(s.quality),
            rating: this.stats?.rowFor(account)?.conservativeRating ?? null,
            rating_delta: deltaByAccount.get(account) ?? 0,
            intent_rate: Math.round(s.intentRate * 100),
            intent_coherent_rate: Math.round(s.intentCoherentRate * 100),
            metrics: s.quality,
          }
        : null;
      session.send({ type: "round_end", round: this.round, reason, standings, your });
    }

    this.saveReplay(standings);

    this.restartTimer = setTimeout(() => this.startRound(), this.serverConfig.roundRestartDelayMs);
  }

  private saveReplay(standings: unknown): void {
    if (!this.game) return;
    const dir = resolve("replays");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${this.baseSeed}-r${this.round}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        seed: this.game.seed,
        config: this.game.config,
        world: { width: this.game.config.width, height: this.game.config.height },
        obstacles: staticMap(this.game).obstacles,
        frames: this.frames,
        standings,
      }),
    );
  }
}
