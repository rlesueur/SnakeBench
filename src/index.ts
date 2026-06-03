import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { type NpcKind } from "./npc/bots.js";
import { type Participant, runMatch } from "./match/runner.js";

/**
 * Headless match runner. Pits the NPC roster against each other, prints the
 * final standings, and writes a replay JSON for the (future) spectator viewer.
 *
 * Usage: npm run match -- [seed] [roster comma-separated]
 *   npm run match
 *   npm run match -- match_001 greedy,survivor,hunter,claimer,random
 */
function main(): void {
  const seed = process.argv[2] ?? "match_001";
  const rosterArg = process.argv[3] ?? "greedy,survivor,hunter,glutton,random";
  const kinds = rosterArg.split(",").map((s) => s.trim()) as NpcKind[];

  const participants: Participant[] = kinds.map((kind, i) => ({
    id: `npc_${kind}_${i + 1}`,
    displayName: `npc_${kind}`,
    isNpc: true,
    npcKind: kind,
  }));

  const replay = runMatch(participants, seed, DEFAULT_CONFIG);

  console.log(`\nMatch ${seed} — ${replay.frames.length - 1} ticks, ${participants.length} snakes`);
  console.log("Rank  Snake            PeakSize  Died@");
  for (const s of replay.standings) {
    const died = s.diedAtTick === null ? "survived" : String(s.diedAtTick);
    console.log(
      `  ${String(s.rank).padEnd(3)} ${s.displayName.padEnd(16)} ${String(s.peakSize).padEnd(8)} ${died}`,
    );
  }

  const dir = resolve("replays");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${seed}.json`);
  writeFileSync(file, JSON.stringify(replay));
  console.log(`\nReplay written to ${file}`);
}

main();
