import { DEFAULT_CONFIG, type GameConfig } from "../config.js";
import { Rng } from "../rng.js";
import {
  type Cell,
  type Direction,
  DELTA,
  type PowerKind,
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
  newPending: number;
  comboLevel: number;
  ate: boolean;
}

interface Resolution {
  dead: Set<string>;
  /** Growth granted to head-to-head winners by absorbing the loser. */
  absorb: Map<string, number>;
}

/**
 * The authoritative Grid Snake simulation. Pure and deterministic: given the
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
  /** Power-up pickups, keyed "x,y" -> kind. */
  readonly powerUps = new Map<string, PowerKind>();

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
    game.replenishPowerUps();
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
    const cols = Math.max(1, Math.ceil(Math.sqrt(specs.length)));
    const rows = Math.max(1, Math.ceil(specs.length / cols));
    specs.forEach((spec, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const headX = Math.max(startingLength, Math.round(((col + 1) * width) / (cols + 1)));
      const y = Math.round(((row + 1) * height) / (rows + 1));
      const body: Cell[] = [];
      for (let seg = 0; seg < startingLength; seg++) {
        body.push({ x: headX - seg, y });
      }
      this.snakes.push({
        id: spec.id,
        displayName: spec.displayName,
        isNpc: spec.isNpc,
        alive: true,
        heading: "right",
        body,
        pendingGrowth: 0,
        comboLevel: 0,
        lastAteTick: -999,
        frenzyUntil: 0,
        peakSize: startingLength,
        diedAtTick: null,
      });
    });
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

  // --- the tick ------------------------------------------------------------

  /**
   * Advance one tick. `moves` gives each snake's chosen direction; snakes in
   * `sheds` also drop tail segments this tick.
   */
  step(moves: Map<string, Direction>, sheds: Set<string> = new Set()): void {
    const planned: PlannedMove[] = [];

    for (const snake of this.snakes) {
      if (!snake.alive) continue;
      let heading = moves.get(snake.id) ?? snake.heading;
      let newHead = this.headFrom(snake, heading);

      if (snake.body.length > 1 && sameCell(newHead, snake.body[1]!)) {
        heading = snake.heading;
        newHead = this.headFrom(snake, heading);
      }

      let eaten = this.food.get(cellKey(newHead)) ?? 0;
      const frenzy = snake.frenzyUntil > this.tick;
      if (eaten > 0 && frenzy) eaten *= 2;

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

      planned.push({ snake, heading, newHead, newBody, eaten, newPending, comboLevel, ate });
    }

    const { dead, absorb } = this.resolveCollisions(planned);

    for (const p of planned) {
      if (dead.has(p.snake.id)) continue;
      const s = p.snake;
      s.heading = p.heading;
      s.body = p.newBody;
      s.pendingGrowth = p.newPending + (absorb.get(s.id) ?? 0);
      if (p.ate) {
        s.comboLevel = p.comboLevel;
        s.lastAteTick = this.tick;
        this.food.delete(cellKey(p.newHead));
      }
      this.collectPowerUp(s, p.newHead);
    }

    this.killSnakes(planned, dead);
    this.applySheds(sheds, dead);

    for (const p of planned) {
      if (dead.has(p.snake.id)) continue;
      p.snake.peakSize = Math.max(p.snake.peakSize, p.snake.body.length);
    }

    this.replenishFood();
    this.replenishPowerUps();
    this.tick += 1;
  }

  private headFrom(snake: Snake, heading: Direction): Cell {
    const head = snake.body[0]!;
    const d = DELTA[heading];
    return { x: head.x + d.x, y: head.y + d.y };
  }

  private resolveCollisions(planned: PlannedMove[]): Resolution {
    const dead = new Set<string>();
    const absorb = new Map<string, number>();

    const bodyCells = new Set<string>();
    for (const p of planned) {
      for (let i = 1; i < p.newBody.length; i++) {
        bodyCells.add(cellKey(p.newBody[i]!));
      }
    }

    const byHead = new Map<string, PlannedMove[]>();
    for (const p of planned) {
      const k = cellKey(p.newHead);
      (byHead.get(k) ?? byHead.set(k, []).get(k)!).push(p);
    }

    for (const p of planned) {
      const k = cellKey(p.newHead);
      if (!this.inBounds(p.newHead) || this.obstacles.has(k)) {
        dead.add(p.snake.id);
        continue;
      }
      if (bodyCells.has(k)) {
        dead.add(p.snake.id);
        continue;
      }
      const group = byHead.get(k)!;
      if (group.length > 1) {
        const maxLen = Math.max(...group.map((g) => g.newBody.length));
        const winners = group.filter((g) => g.newBody.length === maxLen);
        const isSoleWinner = winners.length === 1 && winners[0]!.snake.id === p.snake.id;
        if (!isSoleWinner) {
          dead.add(p.snake.id);
        } else {
          // Sole winner absorbs a fraction of the longest loser.
          const loserLen = Math.max(
            ...group.filter((g) => g.snake.id !== p.snake.id).map((g) => g.newBody.length),
          );
          absorb.set(p.snake.id, Math.floor(loserLen * this.config.absorbFraction));
        }
      }
    }

    return { dead, absorb };
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

  private applySheds(sheds: Set<string>, dead: Set<string>): void {
    const { shedSegments, shedMinLength } = this.config;
    for (const id of sheds) {
      const snake = this.snakeById(id);
      if (!snake || !snake.alive || dead.has(id)) continue;
      let shed = 0;
      while (shed < shedSegments && snake.body.length > shedMinLength) {
        const tail = snake.body.pop()!;
        if (this.inBounds(tail) && !this.obstacles.has(cellKey(tail))) {
          this.food.set(cellKey(tail), 1);
        }
        shed += 1;
      }
    }
  }

  private collectPowerUp(snake: Snake, head: Cell): void {
    const k = cellKey(head);
    const kind = this.powerUps.get(k);
    if (!kind) return;
    this.powerUps.delete(k);
    if (kind === "frenzy") snake.frenzyUntil = this.tick + this.config.frenzyDurationTicks;
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

  /** Cells free of snakes, food, obstacles and power-ups. */
  private freeCells(): Cell[] {
    const { width, height } = this.config;
    const occupied = this.occupiedCells();
    const out: Cell[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = key(x, y);
        if (occupied.has(k) || this.food.has(k) || this.obstacles.has(k) || this.powerUps.has(k)) {
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

  private replenishPowerUps(): void {
    if (this.powerUps.size >= this.config.powerUpTarget) return;
    const candidates = this.freeCells();
    while (this.powerUps.size < this.config.powerUpTarget && candidates.length > 0) {
      const i = this.rng.int(candidates.length);
      const c = candidates[i]!;
      candidates[i] = candidates[candidates.length - 1]!;
      candidates.pop();
      this.powerUps.set(cellKey(c), "frenzy");
    }
  }
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}
