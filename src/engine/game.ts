import { DEFAULT_CONFIG, type GameConfig } from "../config.js";
import {
  applyTransform,
  constraintViolation,
  lethalFoodValue,
  obstaclesPassable,
} from "./laws.js";
import { Rng } from "../rng.js";
import {
  type Cell,
  type Direction,
  DELTA,
  type Snake,
  cellKey,
  key,
} from "../types.js";

export interface SnakeSpec {
  id: string;
  displayName: string;
  isNpc: boolean;
}

interface PlannedMove {
  snake: Snake;
  heading: Direction;
  newHead: Cell;
  newBody: Cell[];
  eaten: number;
  /** Raw value of food on the entered cell, before the foodGrows gate — used to
   * detect poison (lethal high-value food). */
  rawFood: number;
  newPending: number;
  comboLevel: number;
  ate: boolean;
}

/** Why a snake died this tick (for the spectator kill feed). */
export type DeathCause = "wall" | "obstacle" | "body" | "head2head" | "poison" | "unlawful" | "timeout";

/** A notable event produced by a single `step`, for spectators/commentary. */
export type GameEvent =
  | { kind: "death"; id: string; displayName: string; isNpc: boolean; cause: DeathCause; tick: number }
  | {
      kind: "kill";
      id: string;
      displayName: string;
      isNpc: boolean;
      victim: string;
      victimName: string;
      amount: number;
      tick: number;
    }
  | { kind: "waypoint"; id: string; displayName: string; isNpc: boolean; index: number; cell: Cell; tick: number };

interface Resolution {
  dead: Set<string>;
  /** Cause of death per dead snake. */
  causes: Map<string, DeathCause>;
  /** Growth granted to kill winners by absorbing the loser. */
  absorb: Map<string, number>;
  /** Kills this tick: who killed whom and how much they absorbed. A single snake
   * can register several kills in one tick (e.g. two rivals cut off at once). */
  kills: Array<{ winner: string; victim: string; amount: number }>;
}

/**
 * The authoritative SnakeBench simulation. Pure and deterministic: given the
 * same seed and the same ordered actions, `step` always produces the same
 * result. No I/O, no wall-clock, no Math.random.
 */
export class Game {
  readonly config: GameConfig;
  private readonly rng: Rng;
  readonly seed: string;

  tick = 0;
  readonly snakes: Snake[] = [];
  /** Food cells, keyed "x,y" -> growth value. */
  readonly food = new Map<string, number>();
  /** Static deadly obstacle cells. */
  readonly obstacles = new Set<string>();

  private constructor(config: GameConfig, seed: string) {
    this.config = config;
    this.seed = seed;
    this.rng = new Rng(seed);
  }

  static create(
    specs: SnakeSpec[],
    seed: string,
    config: GameConfig = DEFAULT_CONFIG,
  ): Game {
    const game = new Game(config, seed);
    game.placeSnakes(specs);
    game.placeObstacles();
    game.replenishFood();
    return game;
  }

  // --- queries -------------------------------------------------------------

  aliveSnakes(): Snake[] {
    return this.snakes.filter((s) => s.alive);
  }

  snakeById(id: string): Snake | undefined {
    return this.snakes.find((s) => s.id === id);
  }

  sizeOf(snake: Snake): number {
    return snake.body.length;
  }

  private inBounds(c: Cell): boolean {
    return c.x >= 0 && c.x < this.config.width && c.y >= 0 && c.y < this.config.height;
  }

  private occupiedCells(): Set<string> {
    const occ = new Set<string>();
    for (const s of this.snakes) {
      if (!s.alive) continue;
      for (const c of s.body) occ.add(cellKey(c));
    }
    return occ;
  }

  // --- setup ---------------------------------------------------------------

  private placeSnakes(specs: SnakeSpec[]): void {
    const { startingLength, width, height } = this.config;
    const headings: Direction[] = ["up", "down", "left", "right"];
    const buffer = 2; // keep spawns off the walls
    const gap = 3; // preferred spacing between spawns
    const occupied = new Set<string>(); // actual body cells (no overlap allowed)
    const spaced = new Set<string>(); // body cells + gap (preferred spacing)

    // Lay a body of `startingLength` with its head at (hx,hy), trailing in the
    // direction opposite `heading` (same convention as movement).
    const bodyFor = (hx: number, hy: number, heading: Direction): Cell[] => {
      const d = DELTA[heading];
      const body: Cell[] = [];
      for (let seg = 0; seg < startingLength; seg++) {
        body.push({ x: hx - d.x * seg, y: hy - d.y * seg });
      }
      return body;
    };
    const inField = (c: Cell): boolean =>
      c.x >= buffer && c.x < width - buffer && c.y >= buffer && c.y < height - buffer;
    const fits = (body: Cell[], blocked: Set<string>): boolean =>
      body.every((c) => inField(c) && !blocked.has(cellKey(c)));

    const commit = (spec: SnakeSpec, body: Cell[], heading: Direction): void => {
      for (const c of body) {
        occupied.add(cellKey(c));
        for (let dy = -gap; dy <= gap; dy++) {
          for (let dx = -gap; dx <= gap; dx++) spaced.add(key(c.x + dx, c.y + dy));
        }
      }
      this.snakes.push({
        id: spec.id,
        displayName: spec.displayName,
        isNpc: spec.isNpc,
        alive: true,
        heading,
        body,
        pendingGrowth: 0,
        comboLevel: 0,
        lastAteTick: -999,
        zoneTicks: 0,
        waypointIndex: 0,
        peakSize: startingLength,
        diedAtTick: null,
      });
    };

    const xSpan = Math.max(1, width - 2 * buffer);
    const ySpan = Math.max(1, height - 2 * buffer);
    for (const spec of specs) {
      let placed = false;

      // 1) Randomised, well-spaced placement (seeded — deterministic per round).
      for (let attempt = 0; attempt < 300 && !placed; attempt++) {
        const heading = headings[this.rng.int(4)]!;
        const body = bodyFor(buffer + this.rng.int(xSpan), buffer + this.rng.int(ySpan), heading);
        if (fits(body, spaced)) {
          commit(spec, body, heading);
          placed = true;
        }
      }

      // 2) Guaranteed overlap-free scan if the world is crowded.
      for (let h = 0; h < headings.length && !placed; h++) {
        const heading = headings[(this.rng.int(4) + h) % headings.length]!;
        for (let hy = buffer; hy < height - buffer && !placed; hy++) {
          for (let hx = buffer; hx < width - buffer && !placed; hx++) {
            const body = bodyFor(hx, hy, heading);
            if (fits(body, occupied)) {
              commit(spec, body, heading);
              placed = true;
            }
          }
        }
      }

      if (!placed) throw new Error("Cannot place snake: play area too small for the roster.");
    }
  }

  private placeObstacles(): void {
    const { width, height, obstacleDensity } = this.config;
    const count = Math.floor(width * height * obstacleDensity);
    if (count <= 0) return;

    // Keep a clear margin around each snake's spawn so nobody starts trapped.
    const reserved = new Set<string>();
    for (const s of this.snakes) {
      for (const c of s.body) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            reserved.add(key(c.x + dx, c.y + dy));
          }
        }
      }
    }

    // Grow obstacles in small clusters (wall-like blobs) rather than uniform
    // noise: cleaner to read and more meaningful to navigate around.
    let placed = 0;
    let attempts = 0;
    const maxAttempts = count * 30;
    while (placed < count && attempts < maxAttempts) {
      attempts += 1;
      let cx = this.rng.int(width);
      let cy = this.rng.int(height);
      const blob = 3 + this.rng.int(7); // 3–9 cells per cluster
      for (let i = 0; i < blob && placed < count; i++) {
        const k = key(cx, cy);
        if (this.inBounds({ x: cx, y: cy }) && !reserved.has(k) && !this.obstacles.has(k)) {
          this.obstacles.add(k);
          placed += 1;
        }
        cx += this.rng.int(3) - 1;
        cy += this.rng.int(3) - 1;
      }
    }
  }

  /** Advance one tick. `moves` gives each snake's chosen direction. */
  step(moves: Map<string, Direction>): GameEvent[] {
    const events: GameEvent[] = [];
    const planned: PlannedMove[] = [];
    const laws = this.config.laws ?? [];

    for (const snake of this.snakes) {
      if (!snake.alive) continue;
      const submitted = moves.get(snake.id) ?? snake.heading;
      // Transform laws (rotate/mirror) remap the submitted direction into the real
      // heading before anything else; the neck-reversal guard then runs on it.
      let heading = laws.length ? applyTransform(submitted, laws) : submitted;
      let newHead = this.headFrom(snake, heading);

      if (snake.body.length > 1 && sameCell(newHead, snake.body[1]!)) {
        heading = snake.heading;
        newHead = this.headFrom(snake, heading);
      }

      const rawFood = this.food.get(cellKey(newHead)) ?? 0;
      // On "carnivore" rounds, food is still consumed (cleared) but yields no
      // growth — the only way to grow is by cutting rivals off.
      const eaten = this.config.foodGrows ? rawFood : 0;

      // Combo: chained eating adds escalating bonus growth.
      let comboLevel = snake.comboLevel;
      let gain = 0;
      const ate = eaten > 0;
      if (ate) {
        comboLevel = this.tick - snake.lastAteTick <= this.config.comboWindowTicks
          ? snake.comboLevel + 1
          : 1;
        gain = eaten + Math.min(comboLevel - 1, this.config.comboMaxBonus);
      }

      const owed = snake.pendingGrowth + gain;
      const keepTail = owed > 0;
      const newPending = keepTail ? owed - 1 : 0;

      const newBody = [newHead, ...snake.body.map((c) => ({ ...c }))];
      if (!keepTail) newBody.pop();

      planned.push({ snake, heading, newHead, newBody, eaten, rawFood, newPending, comboLevel, ate });
    }

    const { dead, causes, absorb, kills } = this.resolveCollisions(planned);

    // Constraint laws (no_turn / cadence / confine): a move that breaks the round's
    // law is fatal, cause "unlawful". Judged after collisions so an already-dead
    // snake isn't double-counted.
    if (laws.length) {
      for (const p of planned) {
        if (dead.has(p.snake.id)) continue;
        const violated = constraintViolation(laws, {
          prevHead: p.snake.body[0]!,
          prevHeading: p.snake.heading,
          heading: p.heading,
          newHead: p.newHead,
          tick: this.tick,
        });
        if (violated) {
          dead.add(p.snake.id);
          causes.set(p.snake.id, "unlawful");
        }
      }
    }

    // Poison rounds: eating food at/above the poison threshold is lethal. Applied
    // after collisions so a snake already dead this tick isn't double-counted.
    if (this.config.poisonValue != null) {
      const threshold = this.config.poisonValue;
      for (const p of planned) {
        if (dead.has(p.snake.id)) continue;
        if (p.rawFood >= threshold) {
          dead.add(p.snake.id);
          causes.set(p.snake.id, "poison");
          this.food.delete(cellKey(p.newHead));
        }
      }
    }

    // Semantic law (inversion): the danger map is flipped — large food is lethal to
    // eat (obstacle passability is handled inside resolveCollisions).
    const lethalFood = lethalFoodValue(laws);
    if (lethalFood != null) {
      for (const p of planned) {
        if (dead.has(p.snake.id)) continue;
        if (p.rawFood >= lethalFood) {
          dead.add(p.snake.id);
          causes.set(p.snake.id, "poison");
          this.food.delete(cellKey(p.newHead));
        }
      }
    }

    for (const p of planned) {
      if (dead.has(p.snake.id)) continue;
      const s = p.snake;
      s.heading = p.heading;
      s.body = p.newBody;
      s.pendingGrowth = p.newPending + (absorb.get(s.id) ?? 0);
      if (p.ate) {
        s.comboLevel = p.comboLevel;
        s.lastAteTick = this.tick;
      }
      // Clear any food on the entered cell even if it gave no growth (carnivore).
      this.food.delete(cellKey(p.newHead));
    }

    this.killSnakes(planned, dead);
    this.applyFamine(dead);
    events.push(...this.applyObjectives(dead));

    for (const p of planned) {
      if (dead.has(p.snake.id)) continue;
      p.snake.peakSize = Math.max(p.snake.peakSize, p.snake.body.length);
    }

    // Emit events after state has settled, so names/flags are accurate.
    for (const id of dead) {
      const s = this.snakeById(id);
      if (!s) continue;
      events.push({
        kind: "death",
        id,
        displayName: s.displayName,
        isNpc: s.isNpc,
        cause: causes.get(id) ?? "body",
        tick: this.tick,
      });
    }
    for (const { winner, victim, amount } of kills) {
      const w = this.snakeById(winner);
      const v = this.snakeById(victim);
      if (!w) continue;
      events.push({
        kind: "kill",
        id: winner,
        displayName: w.displayName,
        isNpc: w.isNpc,
        victim,
        victimName: v?.displayName ?? victim,
        amount,
        tick: this.tick,
      });
    }

    this.replenishFood();
    this.tick += 1;
    return events;
  }

  /** Force-eliminate a snake (e.g. repeated action timeouts). Drops a carcass like
   * a normal death but does not advance the tick counter. */
  eliminate(id: string, cause: DeathCause): GameEvent | null {
    const snake = this.snakeById(id);
    if (!snake || !snake.alive) return null;
    snake.alive = false;
    snake.diedAtTick = this.tick + 1;
    for (const c of snake.body) {
      if (this.inBounds(c) && !this.obstacles.has(cellKey(c))) {
        this.food.set(cellKey(c), this.config.carcassFoodValue);
      }
    }
    return {
      kind: "death",
      id: snake.id,
      displayName: snake.displayName,
      isNpc: snake.isNpc,
      cause,
      tick: this.tick,
    };
  }

  private headFrom(snake: Snake, heading: Direction): Cell {
    const head = snake.body[0]!;
    const d = DELTA[heading];
    return { x: head.x + d.x, y: head.y + d.y };
  }

  private resolveCollisions(planned: PlannedMove[]): Resolution {
    const dead = new Set<string>();
    const causes = new Map<string, DeathCause>();
    const absorb = new Map<string, number>();
    const kills: Array<{ winner: string; victim: string; amount: number }> = [];
    const kill = (id: string, cause: DeathCause): void => {
      dead.add(id);
      causes.set(id, cause);
    };
    // Under the "inversion" law, obstacle cells are harmless to enter.
    const passObstacles = obstaclesPassable(this.config.laws ?? []);
    // Record a cut-off / duel kill and (optionally) grant the killer growth.
    const credit = (winner: string, victim: string, victimLen: number, frac: number): void => {
      const amount = Math.floor(victimLen * frac);
      if (amount > 0) absorb.set(winner, (absorb.get(winner) ?? 0) + amount);
      kills.push({ winner, victim, amount });
    };

    // Map each occupied body cell (everything behind a head) to its owner, so a
    // snake that runs into it can be attributed as that owner's kill (a "cut-off").
    const bodyOwner = new Map<string, string>();
    for (const p of planned) {
      for (let i = 1; i < p.newBody.length; i++) {
        bodyOwner.set(cellKey(p.newBody[i]!), p.snake.id);
      }
    }

    const byHead = new Map<string, PlannedMove[]>();
    for (const p of planned) {
      const k = cellKey(p.newHead);
      (byHead.get(k) ?? byHead.set(k, []).get(k)!).push(p);
    }

    for (const p of planned) {
      const k = cellKey(p.newHead);
      if (!this.inBounds(p.newHead)) {
        kill(p.snake.id, "wall");
        continue;
      }
      if (this.obstacles.has(k) && !passObstacles) {
        kill(p.snake.id, "obstacle");
        continue;
      }
      const owner = bodyOwner.get(k);
      if (owner) {
        kill(p.snake.id, "body");
        // Running into ANOTHER snake's body is a cut-off kill for that snake.
        // Running into your own body is just self-elimination (no credit).
        if (owner !== p.snake.id) {
          credit(owner, p.snake.id, p.newBody.length, this.config.cutoffAbsorbFraction);
        }
        continue;
      }
      const group = byHead.get(k)!;
      if (group.length > 1) {
        const mode = this.config.headToHead;
        if (mode === "all_die") {
          // No winners: every snake meeting head-on here dies.
          kill(p.snake.id, "head2head");
          continue;
        }
        const lens = group.map((g) => g.newBody.length);
        const target = mode === "shortest" ? Math.min(...lens) : Math.max(...lens);
        const winners = group.filter((g) => g.newBody.length === target);
        const isSoleWinner = winners.length === 1 && winners[0]!.snake.id === p.snake.id;
        if (!isSoleWinner) {
          kill(p.snake.id, "head2head");
        } else {
          // Sole winner absorbs a fraction of the longest loser.
          const losers = group.filter((g) => g.snake.id !== p.snake.id);
          const loserLen = Math.max(...losers.map((g) => g.newBody.length));
          const victim = losers.find((g) => g.newBody.length === loserLen)!.snake.id;
          credit(p.snake.id, victim, loserLen, this.config.absorbFraction);
        }
      }
    }

    return { dead, causes, absorb, kills };
  }

  private killSnakes(planned: PlannedMove[], dead: Set<string>): void {
    for (const p of planned) {
      if (!dead.has(p.snake.id)) continue;
      const snake = p.snake;
      snake.alive = false;
      snake.diedAtTick = this.tick + 1;
      for (const c of snake.body) {
        if (this.inBounds(c) && !this.obstacles.has(cellKey(c))) {
          this.food.set(cellKey(c), this.config.carcassFoodValue);
        }
      }
    }
  }

  /**
   * Famine ("length tax"): on every `lengthTaxTicks`-th tick, any snake that has
   * not eaten within that window withers by one tail segment (down to its
   * starting length). The lost segment does NOT drop as food — it is gone. Forces
   * agents to keep feeding instead of camping defensively.
   */
  private applyFamine(dead: Set<string>): void {
    const period = this.config.lengthTaxTicks;
    if (period <= 0 || this.tick <= 0 || this.tick % period !== 0) return;
    const floor = this.config.startingLength;
    for (const snake of this.snakes) {
      if (!snake.alive || dead.has(snake.id)) continue;
      if (this.tick - snake.lastAteTick < period) continue;
      if (snake.body.length > floor) snake.body.pop();
    }
  }

  /**
   * Drop one or more high-value "special" foods (e.g. a golden apple) onto random
   * free cells. Deterministic via the game RNG. Used by rule-card modifiers.
   */
  addSpecialFood(value: number, count = 1): void {
    const candidates = this.freeCells();
    for (let n = 0; n < count && candidates.length > 0; n++) {
      const i = this.rng.int(candidates.length);
      const c = candidates[i]!;
      candidates[i] = candidates[candidates.length - 1]!;
      candidates.pop();
      this.food.set(cellKey(c), value);
    }
  }

  /** Advance the round's spatial objectives: tally zone occupancy and relay
   * waypoint progress for every snake still alive after collisions. */
  private applyObjectives(dead: Set<string>): GameEvent[] {
    const out: GameEvent[] = [];
    const zone = this.config.scoreZone;
    const wps = this.config.waypoints;
    if (!zone && !wps) return out;
    for (const s of this.snakes) {
      if (!s.alive || dead.has(s.id)) continue;
      const head = s.body[0]!;
      if (zone && head.x >= zone.x && head.x < zone.x + zone.w && head.y >= zone.y && head.y < zone.y + zone.h) {
        s.zoneTicks += 1;
      }
      if (wps && s.waypointIndex < wps.length) {
        const target = wps[s.waypointIndex]!;
        if (head.x === target.x && head.y === target.y) {
          s.waypointIndex += 1;
          out.push({
            kind: "waypoint", id: s.id, displayName: s.displayName, isNpc: s.isNpc,
            index: s.waypointIndex, cell: { ...target }, tick: this.tick,
          });
        }
      }
    }
    return out;
  }

  private spawnValue(): number {
    const types = this.config.foodTypes;
    const total = types.reduce((s, t) => s + t.weight, 0);
    let r = this.rng.next() * total;
    for (const t of types) {
      if (r < t.weight) return t.value;
      r -= t.weight;
    }
    return types[types.length - 1]!.value;
  }

  /** Cells free of snakes, food and obstacles. */
  private freeCells(): Cell[] {
    const { width, height } = this.config;
    const occupied = this.occupiedCells();
    const out: Cell[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = key(x, y);
        if (occupied.has(k) || this.food.has(k) || this.obstacles.has(k)) {
          continue;
        }
        out.push({ x, y });
      }
    }
    return out;
  }

  private replenishFood(): void {
    if (this.food.size >= this.config.foodTarget) return;
    const candidates = this.freeCells();
    while (this.food.size < this.config.foodTarget && candidates.length > 0) {
      const i = this.rng.int(candidates.length);
      const c = candidates[i]!;
      candidates[i] = candidates[candidates.length - 1]!;
      candidates.pop();
      this.food.set(cellKey(c), this.spawnValue());
    }
  }
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}
