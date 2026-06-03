/**
 * Central, tunable configuration for the Grid Snake + Territory game.
 *
 * Every balance knob lives here so playtesting is a one-line change. In
 * particular `tickDeadlineMs` is PROVISIONAL (see spec) and will be tuned
 * against a real agent during local testing.
 */
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

  /** Fraction of a defeated snake's length absorbed by a head-to-head winner. */
  absorbFraction: number;

  /** Eating again within this many ticks continues a combo. */
  comboWindowTicks: number;
  /** Maximum bonus growth added by a combo streak. */
  comboMaxBonus: number;

  /** Number of power-up pickups kept on the board. */
  powerUpTarget: number;
  /** How long the frenzy power-up doubles food value, in ticks. */
  frenzyDurationTicks: number;

  /** Segments dropped when a snake sheds its tail (escape mechanic). */
  shedSegments: number;
  /** A snake cannot shed below this length. */
  shedMinLength: number;

  /** Manhattan radius of an agent's vision window around its head. */
  visionRadius: number;

  /** Body length each snake starts with. */
  startingLength: number;

  /** Hard cap on match length in ticks (safety valve). */
  maxTicks: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  width: 200,
  height: 200,
  tickDeadlineMs: 2000,
  foodTarget: 400,
  foodTypes: [
    { value: 1, weight: 80 }, // common pellet
    { value: 3, weight: 16 }, // fruit
    { value: 6, weight: 4 }, // rare feast
  ],
  carcassFoodValue: 2,
  obstacleDensity: 0.009,
  absorbFraction: 0.5,
  comboWindowTicks: 4,
  comboMaxBonus: 4,
  powerUpTarget: 8,
  frenzyDurationTicks: 30,
  shedSegments: 3,
  shedMinLength: 3,
  visionRadius: 15,
  startingLength: 3,
  maxTicks: 1200,
};

/** Server / arena configuration (live match hosting). */
export interface ServerConfig {
  port: number;
  /** Target lobby size when few agents are online; NPCs backfill up to this. */
  minSnakes: number;
  /** Minimum NPCs kept as rating anchors, even in a busy player lobby. */
  npcFloor: number;
  /** NPC kinds used to backfill, cycled in order. */
  npcBackfill: string[];
  /** Pause between a round ending and the next starting, in ms. */
  roundRestartDelayMs: number;
  /** Target grid cells per snake — drives dynamic play-area sizing. */
  cellsPerSnake: number;
  /** Tick length for ambient (no-agent) attract rounds — faster than the agent
   * deadline so the spectator keeps cycling when nobody is connected. */
  ambientTickMs: number;
  /** Hard tick cap for ambient rounds (safety valve, shorter than maxTicks). */
  ambientMaxTicks: number;
  /** End a round if no snake has died for this many ticks while only a handful
   * remain — prevents survivors from circling forever. */
  stallTicks: number;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 8080,
  minSnakes: 12,
  npcFloor: 2,
  npcBackfill: ["greedy", "survivor", "hunter", "glutton"],
  roundRestartDelayMs: 2000,
  cellsPerSnake: 1400,
  ambientTickMs: 200,
  ambientMaxTicks: 600,
  stallTicks: 160,
};
