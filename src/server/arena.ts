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
import { NPC_REGISTRY, type NpcKind } from "../npc/bots.js";
import { DIRECTIONS, type Direction } from "../types.js";
import { buildAgentView } from "./view.js";
import { fullSnapshot, staticMap, type SpectatorFrame } from "./snapshot.js";
import type { StatsStore } from "./stats.js";
import type { LogStore } from "./logs.js";

export interface AgentSession {
  /** Stable snake id for this connection (used across rounds). */
  snakeId: string;
  displayName: string;
  send: (msg: unknown) => void;
  pendingMove: Direction | null;
  pendingShed: boolean;
  alive: boolean;
  /** Last vision view sent, with its tick and send time (for decision logs). */
  lastView: unknown;
  lastViewTick: number;
  lastSentAt: number;
}

export interface ArenaHooks {
  broadcastSpectators: (msg: unknown) => void;
}

const VALID_MOVES = new Set<string>(DIRECTIONS);

/**
 * Hosts a continuously running arena: rounds of Grid Snake + Territory played in
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
  /** Alive-snake count last tick, and the tick it last changed (stall detection). */
  private lastAlive = 0;
  private lastAliveChangeTick = 0;
  /** Current tick interval, so we only recreate the timer when it changes. */
  private currentTickMs = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
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

  start(): void {
    this.startRound();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.tickTimer = null;
    this.restartTimer = null;
  }

  getConfig(): GameConfig {
    return this.config;
  }

  /** Latest full frame + static map, for a spectator that just connected. */
  currentFrame():
    | { round: number; world: { width: number; height: number }; obstacles: ReturnType<typeof staticMap>["obstacles"]; frame: SpectatorFrame }
    | null {
    if (!this.game) return null;
    return {
      round: this.round,
      world: { width: this.game.config.width, height: this.game.config.height },
      obstacles: staticMap(this.game).obstacles,
      frame: fullSnapshot(this.game),
    };
  }

  // --- agent membership ----------------------------------------------------

  addAgent(session: AgentSession): void {
    const wasEmpty = this.agents.size === 0;
    this.agents.set(session.snakeId, session);

    // Between rounds: the pending (or initial) startRound will include them.
    if (!this.roundActive) return;

    // A player round is already running: queue them for the next round rather
    // than disrupting the live match (24/7 fairness). But if the current round
    // is an ambient NPC-only game, bring the first real agent in immediately.
    if (wasEmpty) {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.startRound();
    }
  }

  removeAgent(snakeId: string): void {
    this.agents.delete(snakeId);
    // Their snake (if any) simply continues on its last heading until it dies.
  }

  submitAction(snakeId: string, tick: number, move: string, shed = false, evidence: unknown = null): void {
    if (!this.roundActive || !this.game) return;
    const session = this.agents.get(snakeId);
    if (!session) return;
    if (tick !== this.game.tick) return; // stale action
    if (!VALID_MOVES.has(move)) return;
    session.pendingMove = move as Direction;
    if (shed) session.pendingShed = true;

    if (this.logs) {
      this.logs.append({
        ts: Date.now(),
        round: this.round,
        tick,
        account: session.displayName,
        snakeId,
        move,
        shed,
        latencyMs: session.lastSentAt ? Date.now() - session.lastSentAt : null,
        view: session.lastViewTick === tick ? session.lastView : null,
        evidence,
      });
    }
  }

  /** Dynamic play-area: bigger worlds for more snakes, to keep density sane. */
  private worldForPlayers(n: number): { width: number; height: number; foodTarget: number } {
    const side = Math.min(
      260,
      Math.max(80, Math.round(Math.sqrt(Math.max(1, n) * this.serverConfig.cellsPerSnake))),
    );
    return { width: side, height: side, foodTarget: Math.round(side * side * 0.01) };
  }

  // --- round lifecycle -----------------------------------------------------

  private startRound(): void {
    this.round += 1;
    const seed = `${this.baseSeed}-r${this.round}`;

    const specs: SnakeSpec[] = [];
    this.roundAccounts = new Map();
    for (const session of this.agents.values()) {
      specs.push({ id: session.snakeId, displayName: session.displayName, isNpc: false });
      this.roundAccounts.set(session.snakeId, session.displayName);
      session.pendingMove = null;
      session.pendingShed = false;
      session.alive = true;
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

    // Size the play-area to the number of snakes in this round.
    const dims = this.worldForPlayers(specs.length);
    const roundConfig = { ...this.config, ...dims, tickDeadlineMs: tickMs, maxTicks };

    this.game = Game.create(specs, seed, roundConfig);
    this.frames = [fullSnapshot(this.game)];
    this.roundActive = true;
    this.lastAlive = specs.length;
    this.lastAliveChangeTick = 0;

    const world = { width: dims.width, height: dims.height };
    const obstacles = staticMap(this.game).obstacles;
    for (const session of this.agents.values()) {
      session.send({
        type: "round_start",
        round: this.round,
        you_id: session.snakeId,
        world,
        obstacles,
        tick_deadline_ms: this.config.tickDeadlineMs,
      });
    }
    this.hooks.broadcastSpectators({ type: "round_start", round: this.round, world, obstacles });
    this.sendStateToAgents();

    // (Re)create the tick timer only when the cadence changes between rounds.
    if (this.currentTickMs !== tickMs || !this.tickTimer) {
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.currentTickMs = tickMs;
      this.tickTimer = setInterval(() => this.onTick(), tickMs);
    }
  }

  private onTick(): void {
    if (!this.roundActive || !this.game) return;
    const game = this.game;

    const moves = new Map<string, Direction>();
    const sheds = new Set<string>();
    for (const snake of game.aliveSnakes()) {
      const agent = this.agents.get(snake.id);
      if (agent) {
        if (agent.pendingMove) moves.set(snake.id, agent.pendingMove);
        if (agent.pendingShed) sheds.add(snake.id);
        continue;
      }
      const npc = this.npc.get(snake.id);
      if (npc) {
        moves.set(snake.id, NPC_REGISTRY[npc.kind]!.decide(game, snake.id, npc.rng));
      }
    }

    game.step(moves, sheds);

    // Reset agent intents; a missed next tick means "continue current heading".
    for (const session of this.agents.values()) {
      session.pendingMove = null;
      session.pendingShed = false;
    }

    // Notify any agents whose snake just died.
    for (const session of this.agents.values()) {
      const snake = game.snakeById(session.snakeId);
      if (snake && !snake.alive && session.alive) {
        session.alive = false;
        session.send({ type: "dead", tick: game.tick, peak_size: snake.peakSize });
      }
    }

    // Track when the alive-snake count last changed, for stall detection.
    const aliveNow = game.aliveSnakes().length;
    if (aliveNow !== this.lastAlive) {
      this.lastAlive = aliveNow;
      this.lastAliveChangeTick = game.tick;
    }

    const frame = fullSnapshot(game);
    this.frames.push(frame);
    this.hooks.broadcastSpectators({ type: "frame", frame });
    this.sendStateToAgents();

    const reason = this.endReason(game);
    if (reason) this.endRound(reason);
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
    if (game.tick >= game.config.maxTicks) return "time_limit";
    const alive = game.aliveSnakes().length;
    if (alive === 0) return "all_dead";
    if (alive === 1) return "last_standing";
    // Benchmark-aware: once every real agent is out, there is nothing left to
    // measure, so end the round even if NPCs are still circling.
    if (this.roundHasAgents && this.aliveAgentCount(game) === 0) return "agents_eliminated";
    // Stalemate: a few survivors circling without dying. End so the next round
    // can start rather than waiting out the full tick cap.
    if (alive <= 3 && game.tick - this.lastAliveChangeTick >= this.serverConfig.stallTicks) {
      return "stalemate";
    }
    return null;
  }

  private sendStateToAgents(): void {
    if (!this.game) return;
    const deadline = Date.now() + this.config.tickDeadlineMs;
    for (const session of this.agents.values()) {
      const snake = this.game.snakeById(session.snakeId);
      if (!snake || !snake.alive) continue;
      const view = buildAgentView(this.game, session.snakeId, deadline);
      session.lastView = view;
      session.lastViewTick = this.game.tick;
      session.lastSentAt = Date.now();
      session.send({ type: "state", state: view });
    }
  }

  private endRound(reason: string): void {
    if (!this.game) return;
    this.roundActive = false;

    const standings = [...this.game.snakes]
      .sort((a, b) => b.peakSize - a.peakSize)
      .map((s, idx) => ({
        rank: idx + 1,
        id: s.id,
        display_name: s.displayName,
        is_npc: s.isNpc,
        peak_size: s.peakSize,
        died_at_tick: s.diedAtTick,
      }));

    for (const session of this.agents.values()) {
      session.send({ type: "round_end", round: this.round, reason, standings });
    }
    this.hooks.broadcastSpectators({ type: "round_end", round: this.round, reason, standings });

    // Persist per-account benchmark stats for the agent participants.
    if (this.stats) {
      const entries = standings
        .filter((s) => !s.is_npc && this.roundAccounts.has(s.id))
        .map((s) => ({
          account: this.roundAccounts.get(s.id)!,
          rank: s.rank,
          peakSize: s.peak_size,
        }));
      if (entries.length) {
        this.stats.recordRound(this.round, entries);
        const board = this.stats.leaderboard();
        for (const session of this.agents.values()) session.send({ type: "leaderboard", board });
        this.hooks.broadcastSpectators({ type: "leaderboard", board });
      }
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
