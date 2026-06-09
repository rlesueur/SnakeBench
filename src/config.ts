/**
 * Central, tunable configuration for the SnakeBench game.
 *
 * Every balance knob lives here so playtesting is a one-line change. In
 * particular `tickDeadlineMs` is PROVISIONAL (see spec) and will be tuned
 * against a real agent during local testing.
 */
import type { Law } from "./engine/laws.js";
/**
 * Head-to-head collision rule: who survives when two heads meet on the same
 * cell. Set per-round by the active rule card.
 *  - "longest":  the longer snake survives (classic).
 *  - "shortest": the shorter snake survives (inverted).
 *  - "all_die":  both snakes die — no winner.
 */
export type HeadToHead = "longest" | "shortest" | "all_die";

/** A kind of food: how much growth it gives and how often it spawns. */
export interface FoodType {
  /** Growth (segments / score) awarded when eaten. */
  value: number;
  /** Relative spawn weight. */
  weight: number;
}

export interface GameConfig {
  /** Grid dimensions in cells. */
  width: number;
  height: number;

  /** Action deadline per tick, in milliseconds. Provisional — tune via testing. */
  tickDeadlineMs: number;

  /** Target number of food cells kept on the board. */
  foodTarget: number;

  /** Food kinds and their spawn weights. Higher-value food is rarer. */
  foodTypes: FoodType[];

  /** Growth value of the food dropped by each segment of a dead snake. */
  carcassFoodValue: number;

  /** Fraction of the grid filled with deadly static obstacles. */
  obstacleDensity: number;

  /** Whether eating food grows you. Set false by "carnivore" cards, where the
   * only way to grow is to cut rivals off and eat the carcass. */
  foodGrows: boolean;

  /** "Poison" rounds: food whose value is >= this KILLS the snake that eats it
   * (so only small pellets are safe). Undefined = no food is poisonous. */
  poisonValue?: number;

  /** "Zone" objective: a rectangular scoring region; a snake earns a zoneTick for
   * every tick its head is inside it. Undefined on non-zone rounds. */
  scoreZone?: { x: number; y: number; w: number; h: number };

  /** "Relay" objective: an ordered list of waypoint cells each snake must reach in
   * sequence; reaching the next one scores and advances. Undefined otherwise. */
  waypoints?: { x: number; y: number }[];

  /** "Bell" objective: the round ends at this tick and snakes are ranked by their
   * length at that moment. Undefined on non-bell rounds. */
  bellTick?: number;

  /** Fraction of a defeated snake's length absorbed by a head-to-head winner. */
  absorbFraction: number;

  /** Fraction of a victim's length granted to the snake that cut it off (i.e. the
   * owner of the body an enemy ran into). 0 = kills grant no growth directly (the
   * victim still drops a carcass to harvest); the "Bounty" modifier raises this. */
  cutoffAbsorbFraction: number;

  /** Head-to-head collision resolution rule for the round. */
  headToHead: HeadToHead;

  /** Eating again within this many ticks continues a combo. */
  comboWindowTicks: number;
  /** Maximum bonus growth added by a combo streak. */
  comboMaxBonus: number;

  /** Famine decay: if > 0, a snake that has not eaten within this many ticks
   * loses a tail segment every `lengthTaxTicks` ticks (down to its starting
   * length). 0 disables the mechanic. */
  lengthTaxTicks: number;

  /** Manhattan radius of an agent's vision window around its head. */
  visionRadius: number;

  /** Body length each snake starts with. */
  startingLength: number;

  /** Hard cap on match length in ticks (safety valve). */
  maxTicks: number;

  /** "Law" rounds: 0–2 natural-language rules that change the dynamics — how a
   * submitted move is interpreted, which moves are legal, or what cells mean.
   * Enforced at the move chokepoint in `step()`. Empty/undefined = plain physics. */
  laws?: Law[];
}

export const DEFAULT_CONFIG: GameConfig = {
  width: 200,
  height: 200,
  // Safety-net ceiling per move, NOT the expected think time. The adaptive tick
  // resolves the instant every live agent has locked in, so moves are paced by
  // the agents themselves; this value only bounds an agent that never submits
  // (hang/crash), after which the tick resolves without it. Kept generous (60s)
  // so a genuinely slow reasoning model is never cut off mid-thought.
  tickDeadlineMs: 60000,
  foodTarget: 400,
  foodTypes: [
    { value: 1, weight: 80 }, // common pellet
    { value: 3, weight: 16 }, // fruit
    { value: 6, weight: 4 }, // rare feast
  ],
  carcassFoodValue: 2,
  obstacleDensity: 0.009,
  foodGrows: true,
  absorbFraction: 0.5,
  // Cutting a rival off pays on EVERY round (not just kill cards): the killer
  // absorbs this fraction of the victim's length, so aggression is always a live
  // option and snakes have a reason to seek each other out rather than farm alone.
  cutoffAbsorbFraction: 0.35,
  headToHead: "longest",
  comboWindowTicks: 4,
  comboMaxBonus: 4,
  lengthTaxTicks: 0,
  visionRadius: 24,
  // Snakes start with enough body to actually trap a rival; a 3-segment snake
  // can't cut anyone off. The arena scales vision to the (now denser) board.
  startingLength: 5,
  maxTicks: 1200,
};

/** Server / arena configuration (live match hosting). */
export interface ServerConfig {
  port: number;
  /** Target lobby size when few agents are online; NPCs backfill up to this. */
  minSnakes: number;
  /** @deprecated Baseline count is fixed in `BASELINE_ROSTER`; kept for compat. */
  npcFloor: number;
  /** Extra NPC kinds cycled to fill the lobby beyond the fixed baselines. */
  npcBackfill: string[];
  /** Pause between a round ending and the next starting, in ms. */
  roundRestartDelayMs: number;
  /** Grace window after the first agent joins an ambient lobby before the next
   * player round begins, so a burst of agents arriving together share a round. */
  joinGraceMs: number;
  /** Target grid cells per snake — drives dynamic play-area sizing. Kept low so
   * the board stays dense and snakes are forced into contact (competitive play)
   * rather than each farming an empty corner. */
  cellsPerSnake: number;
  /** Maximum real agents placed in a single round. Agents beyond this are
   * queued for the next round (the world stops growing at its size cap, so
   * this keeps board density playable). */
  maxAgentsPerRound: number;
  /** Tick length for ambient (no-agent) attract rounds — faster than the agent
   * deadline so the spectator keeps cycling when nobody is connected. */
  ambientTickMs: number;
  /** Hard tick cap for ambient rounds (safety valve, shorter than maxTicks). */
  ambientMaxTicks: number;
  /** End a round if no snake has died for this many ticks while only a handful
   * remain — prevents survivors from circling forever. */
  stallTicks: number;
  /** Connected agents who fail to submit this many ticks in a row are eliminated;
   * 0 disables. Does not end the round — baselines and filler keep playing. */
  timeoutKillStreak: number;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 8080,
  minSnakes: 16,
  npcFloor: 3,
  npcBackfill: ["greedy", "searcher"],
  roundRestartDelayMs: 2000,
  joinGraceMs: 2000,
  cellsPerSnake: 180,
  maxAgentsPerRound: 48,
  ambientTickMs: 200,
  ambientMaxTicks: 600,
  stallTicks: 160,
  timeoutKillStreak: 3,
};
