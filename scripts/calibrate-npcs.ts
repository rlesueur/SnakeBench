/**
 * NPC anchor calibration. Runs many headless free-for-all games between the
 * built-in NPC strategies (real engine, no mocks), ranks each game by survival
 * exactly like the live arena, and fits a Glicko-2 rating per NPC kind from the
 * pairwise outcomes. Prints suggested NPC_ANCHOR values (normalised so the mean
 * sits at 1500). Nothing is written automatically — copy the table into
 * src/npc/bots.ts.
 *
 * Usage: npm run calibrate -- [games] [perKind] [maxTicks]
 */
import { DEFAULT_CONFIG, type GameConfig } from "../src/config.js";
import { Game, type SnakeSpec } from "../src/engine/game.js";
import { Rng } from "../src/rng.js";
import type { Direction } from "../src/types.js";
import { NPC_REGISTRY, type NpcKind } from "../src/npc/bots.js";
import {
  type Rating,
  type GameResult,
  createRating,
  updateRating,
  expandStandings,
} from "../src/rating/glicko2.js";

const KINDS: NpcKind[] = ["random", "survivor", "greedy", "glutton", "hunter", "searcher"];

const games = Number(process.argv[2] ?? 150);
const perKind = Number(process.argv[3] ?? 3);
const maxTicks = Number(process.argv[4] ?? 700);

function worldFor(n: number): Pick<GameConfig, "width" | "height" | "foodTarget"> {
  const side = Math.min(260, Math.max(80, Math.round(Math.sqrt(n * 1400))));
  return { width: side, height: side, foodTarget: Math.round(side * side * 0.01) };
}

/** Play one headless game; return final standings (rank 1 = best) by survival. */
function playGame(seed: string): Array<{ kind: NpcKind; id: string; rank: number }> {
  const specs: SnakeSpec[] = [];
  const rngs = new Map<string, Rng>();
  const kindOf = new Map<string, NpcKind>();
  let idx = 0;
  for (const kind of KINDS) {
    for (let i = 0; i < perKind; i++) {
      const id = `${kind}_${i}`;
      specs.push({ id, displayName: kind, isNpc: true });
      rngs.set(id, new Rng(`${seed}:${id}`));
      kindOf.set(id, kind);
      idx += 1;
    }
  }
  const config: GameConfig = { ...DEFAULT_CONFIG, ...worldFor(idx), maxTicks };
  const game = Game.create(specs, seed, config);

  while (game.tick < maxTicks && game.aliveSnakes().length > 1) {
    const moves = new Map<string, Direction>();
    for (const s of game.aliveSnakes()) {
      const kind = kindOf.get(s.id)!;
      moves.set(s.id, NPC_REGISTRY[kind]!.decide(game, s.id, rngs.get(s.id)!));
    }
    game.step(moves);
  }

  const deathOrder = (d: number | null): number => d ?? Number.POSITIVE_INFINITY;
  return [...game.snakes]
    .sort((a, b) => deathOrder(b.diedAtTick) - deathOrder(a.diedAtTick) || b.peakSize - a.peakSize)
    .map((s, i) => ({ kind: kindOf.get(s.id)!, id: s.id, rank: i + 1 }));
}

function main(): void {
  const rating = new Map<NpcKind, Rating>(KINDS.map((k) => [k, createRating()]));

  for (let g = 0; g < games; g++) {
    const standings = playGame(`calib-${g}`);
    // Pairwise results computed from this game's *pre-update* ratings.
    const field = standings.map((s) => ({
      id: s.id,
      rank: s.rank,
      rating: rating.get(s.kind)!.rating,
      rd: rating.get(s.kind)!.rd,
    }));
    const pairwise = expandStandings(field);

    // Group every instance's results under its kind, then one update per kind.
    const byKind = new Map<NpcKind, GameResult[]>(KINDS.map((k) => [k, []]));
    for (const s of standings) byKind.get(s.kind)!.push(...(pairwise.get(s.id) ?? []));
    for (const k of KINDS) rating.set(k, updateRating(rating.get(k)!, byKind.get(k)!));

    if ((g + 1) % 25 === 0) process.stdout.write(`  …${g + 1}/${games} games\n`);
  }

  // Normalise so the mean rating is 1500 (anchors are a relative scale).
  const mean = KINDS.reduce((s, k) => s + rating.get(k)!.rating, 0) / KINDS.length;
  const shift = 1500 - mean;

  const rows = KINDS.map((k) => ({
    kind: k,
    rating: Math.round(rating.get(k)!.rating + shift),
    rd: rating.get(k)!.rd,
  })).sort((a, b) => a.rating - b.rating);

  console.log(`\nCalibrated over ${games} games (${perKind} of each kind, maxTicks ${maxTicks}):\n`);
  console.log("kind      rating   (raw rd)");
  for (const r of rows) {
    console.log(`${r.kind.padEnd(9)} ${String(r.rating).padStart(5)}   (rd ${r.rd.toFixed(0)})`);
  }
  console.log("\nSuggested NPC_ANCHOR (rd fixed at 60 — anchors are stable references):");
  for (const r of rows) {
    console.log(`  ${r.kind}: { rating: ${r.rating}, rd: 60 },`);
  }
}

main();
