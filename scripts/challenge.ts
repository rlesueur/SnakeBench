/**
 * Deterministic challenge harness. Runs a single fixed-seed headless match for a
 * chosen roster of NPC strategies and prints reproducible final standings plus a
 * server-authoritative decision-quality score per snake. Same seed + roster =>
 * identical result every time, so it's a stable head-to-head comparison that is
 * completely separate from the live ladder (nothing is persisted or rated).
 *
 * Usage: npm run challenge -- [seed] [roster] [maxTicks]
 *   npm run challenge -- duel-1 "hunter,glutton,survivor,greedy,random" 1000
 */
import { DEFAULT_CONFIG, type GameConfig } from "../src/config.js";
import { Game, type SnakeSpec } from "../src/engine/game.js";
import { Rng } from "../src/rng.js";
import { NPC_REGISTRY } from "../src/npc/bots.js";
import { type Cell, type Direction, cellKey } from "../src/types.js";
import { analyseMove, type MoveContext } from "../src/engine/decision-quality.js";
import { roundDecisionQuality, type RoundQuality } from "../src/server/stats.js";

const FOOD_TICK_FLOOR = 50;

const seed = process.argv[2] ?? "challenge-1";
const roster = (process.argv[3] ?? "hunter,glutton,survivor,greedy,random")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const maxTicks = Number(process.argv[4] ?? 1000);

interface Acc {
  moves: number;
  legal: number;
  safeOpp: number;
  safeChosen: number;
  spaceSum: number;
  lastSafeAlt: boolean;
  avoidableDeath: boolean;
}

function worldFor(n: number): Pick<GameConfig, "width" | "height" | "foodTarget"> {
  const side = Math.min(260, Math.max(80, Math.round(Math.sqrt(n * 1400))));
  return { width: side, height: side, foodTarget: Math.round(side * side * 0.01) };
}

function main(): void {
  const specs: SnakeSpec[] = roster.map((kind, i) => ({
    id: `${kind}_${i}`,
    displayName: kind,
    isNpc: true,
  }));
  const kindOf = new Map(specs.map((s, i) => [s.id, roster[i]!]));
  const rngs = new Map(specs.map((s) => [s.id, new Rng(`${seed}:${s.id}`)]));
  const config: GameConfig = { ...DEFAULT_CONFIG, ...worldFor(specs.length), maxTicks };
  const game = Game.create(specs, seed, config);

  const acc = new Map<string, Acc>(
    specs.map((s) => [s.id, { moves: 0, legal: 0, safeOpp: 0, safeChosen: 0, spaceSum: 0, lastSafeAlt: false, avoidableDeath: false }]),
  );
  const alivePrev = new Map<string, boolean>(specs.map((s) => [s.id, true]));

  while (game.tick < maxTicks && game.aliveSnakes().length > 1) {
    // Decide moves.
    const moves = new Map<string, Direction>();
    for (const s of game.aliveSnakes()) {
      moves.set(s.id, NPC_REGISTRY[kindOf.get(s.id)!]!.decide(game, s.id, rngs.get(s.id)!));
    }

    // Server-authoritative decision-quality sampling (same model as the arena).
    const blocked = new Set<string>();
    const heads: Array<{ id: string; head: Cell; heading: Direction; length: number }> = [];
    for (const s of game.snakes) {
      if (!s.alive) continue;
      for (let i = 0; i < s.body.length - 1; i++) blocked.add(cellKey(s.body[i]!));
      heads.push({ id: s.id, head: s.body[0]!, heading: s.heading, length: s.body.length });
    }
    for (const s of game.aliveSnakes()) {
      const a = acc.get(s.id)!;
      const ctx: MoveContext = {
        width: config.width,
        height: config.height,
        obstacles: game.obstacles,
        blocked,
        head: s.body[0]!,
        heading: s.heading,
        submittedMove: moves.get(s.id) ?? null,
        selfLength: s.body.length,
        enemyHeads: heads.filter((h) => h.id !== s.id).map((h) => ({ head: h.head, heading: h.heading, length: h.length })),
      };
      const r = analyseMove(ctx);
      a.moves += 1;
      if (r.legal) a.legal += 1;
      if (r.hadSafeAlternative) {
        a.safeOpp += 1;
        if (r.choseSafe) a.safeChosen += 1;
      }
      a.spaceSum += r.spaceAfter;
      a.lastSafeAlt = r.hadSafeAlternative;
    }

    game.step(moves);

    // Flag avoidable deaths.
    for (const s of game.snakes) {
      if (alivePrev.get(s.id) && !s.alive) {
        const a = acc.get(s.id)!;
        if (a.lastSafeAlt) a.avoidableDeath = true;
      }
      alivePrev.set(s.id, s.alive);
    }
  }

  const deathOrder = (d: number | null): number => d ?? Number.POSITIVE_INFINITY;
  const standings = [...game.snakes]
    .sort((a, b) => deathOrder(b.diedAtTick) - deathOrder(a.diedAtTick) || b.peakSize - a.peakSize)
    .map((s, i) => {
      const a = acc.get(s.id)!;
      const survival = s.diedAtTick ?? game.tick;
      const growth = Math.max(0, s.peakSize - config.startingLength);
      const q: RoundQuality = {
        moves: a.moves,
        legalRate: a.moves ? a.legal / a.moves : 1,
        safeRate: a.safeOpp ? a.safeChosen / a.safeOpp : 1,
        avoidableDeath: a.avoidableDeath ? 1 : 0,
        avgSpace: a.moves ? a.spaceSum / a.moves : 0,
        foodPerTick: growth / Math.max(survival, FOOD_TICK_FLOOR),
        timeoutRate: 0,
        survivalTicks: survival,
        latencyMs: 0,
        lawMoves: 0,
        lawComprehension: null,
      };
      return { rank: i + 1, kind: kindOf.get(s.id)!, peak: s.peakSize, survival, quality: roundDecisionQuality(q) };
    });

  console.log(`\nChallenge "${seed}" — ${specs.length} snakes, ${game.tick} ticks (deterministic).\n`);
  console.log("rank  kind       peak  survival  quality");
  for (const r of standings) {
    console.log(
      `${String(r.rank).padStart(2)}    ${r.kind.padEnd(9)} ${String(r.peak).padStart(4)}  ${String(r.survival).padStart(8)}  ${String(r.quality).padStart(5)}`,
    );
  }
}

main();
