import { Rng } from "../rng.js";

/**
 * Rule cards: each round is played under one of several rule variants, drawn at
 * random (seeded) and announced to agents and spectators in natural language.
 *
 * The point is to make the benchmark test *reasoning*, not reflexes. A flood-fill
 * "don't trap yourself, eat the nearest food" heuristic is near-optimal for plain
 * survival — so plain survival measures nothing interesting. These cards instead
 * change the *objective itself*: control a zone, race a waypoint relay, be biggest
 * at a bell, hunt for your growth, or stay deliberately small. The greedy-survival
 * policy is wrong for most of them, so doing well requires reading the brief and
 * genuinely changing behaviour. Spatial objectives (zone/relay) are also seeded to
 * a different place each round, so positions can't be hard-coded.
 */

/** What a round is scored/ranked on. */
export type Objective = "survive" | "grow" | "kills" | "zone" | "relay" | "bell" | "fasting";

/** How much food the board carries this round. */
export type FoodMod = "normal" | "scarce" | "feast";

export interface RuleCard {
  /** Stable identifier (also used as a seed-stable key). */
  id: string;
  /** Short display name, e.g. "Zone Control". */
  name: string;
  /** One-sentence natural-language brief shown to agents and spectators. */
  brief: string;
  /** Primary win condition / ranking metric for the round. */
  objective: Objective;
  /** Food availability modifier. */
  foodMod: FoodMod;
  /** When false, eating food gives no growth — you grow only by cutting rivals
   * off and eating the carcass ("carnivore" rounds). */
  foodGrows?: boolean;
  /** Famine decay baked into the card (ticks without eating before withering). */
  lengthTaxTicks?: number;
  /** Cut-off kills grant this fraction of the victim's length as growth. */
  cutoffAbsorbFraction?: number;
  /** Growth value each dead segment drops as food (carcass richness). */
  carcassFoodValue?: number;
  /** Snakes start at this length instead of the default. Kill-focused cards start
   * long so a snake actually has a body to trap rivals with. */
  startingLength?: number;
  /** Multiply the play-area side by this (≈0.75 for combat cards) to pack snakes
   * closer together and force the encounters that make cut-offs possible. */
  boardScale?: number;
  /** Food at/above this value is POISON (lethal). Only small pellets are safe. */
  poisonValue?: number;
}

/**
 * The catalogue. Each card picks an objective and food economy (plus the odd
 * baked-in twist). Spatial objectives ("zone", "relay") and the "bell" tick are
 * generated per-round in the arena from the seed, so even the same card differs.
 */
export const RULE_CARDS: readonly RuleCard[] = [
  {
    id: "classic",
    name: "Classic Survival",
    brief: "Last snake alive wins; if you die, surviving longer ranks higher, with peak length as the tiebreak. Just don't die.",
    objective: "survive",
    foodMod: "normal",
  },
  {
    id: "last_bite",
    name: "Last Bite",
    brief: "Food is SCARCE and the goal is to OUTLAST everyone. Manage your hunger and let rivals make the fatal mistakes.",
    objective: "survive",
    foodMod: "scarce",
  },
  {
    id: "attrition",
    name: "War of Attrition",
    brief: "Last snake alive wins, BUT you wither if you stop eating — you cannot just camp in a corner. Stay fed and stay alive.",
    objective: "survive",
    foodMod: "normal",
    lengthTaxTicks: 14,
  },
  {
    id: "feeding_frenzy",
    name: "Feeding Frenzy",
    brief: "Pure growth race: the largest PEAK LENGTH wins and dying early is not punished. Food is everywhere — eat relentlessly.",
    objective: "grow",
    foodMod: "feast",
  },
  {
    id: "hunger_games",
    name: "Hunger Games",
    brief: "Grow the BIGGEST (largest peak length) — but food is SCARCE, so you must out-position rivals to reach the little there is.",
    objective: "grow",
    foodMod: "scarce",
  },
  {
    id: "zone_control",
    name: "Zone Control",
    brief: "Score one point for every tick your HEAD is inside the marked ZONE (see rules.zone). Most points wins — owning the zone beats hiding in open space, but the zone is where everyone collides.",
    objective: "zone",
    foodMod: "normal",
  },
  {
    id: "king_of_the_hill",
    name: "King of the Hill",
    brief: "Most ticks spent with your HEAD inside the marked ZONE wins — and food is SCARCE, so you must choose between feeding and holding the hill.",
    objective: "zone",
    foodMod: "scarce",
  },
  {
    id: "relay",
    name: "Relay Race",
    brief: "Reach the lit WAYPOINTS in order (see rules.waypoints / your you.next_waypoint). Most waypoints reached wins — plan a route, don't just chase food.",
    objective: "relay",
    foodMod: "normal",
  },
  {
    id: "grand_prix",
    name: "Grand Prix",
    brief: "A waypoint RACE through a FEAST of food: reach the lit waypoints in order (most reached wins). The food is a distraction — stay on the racing line.",
    objective: "relay",
    foodMod: "feast",
  },
  {
    id: "last_bell",
    name: "Last Bell",
    brief: "The round ENDS at the bell (see rules.bell_tick) and whoever is LONGEST at that moment wins. Surviving past the bell is worthless — time your growth to peak right at the end.",
    objective: "bell",
    foodMod: "normal",
  },
  {
    id: "sprint",
    name: "Sprint Finish",
    brief: "Be the LONGEST snake when the bell rings (see rules.bell_tick), with food everywhere. A flat-out growth sprint — but you must still be ALIVE and long at the bell.",
    objective: "bell",
    foodMod: "feast",
  },
  {
    id: "bloodsport",
    name: "Bloodsport",
    brief: "MOST KILLS wins. You start LONG — wrap your body around rivals and force an enemy head into it to cut them off; each kill grows you. Survival only breaks ties.",
    objective: "kills",
    foodMod: "normal",
    cutoffAbsorbFraction: 0.5,
    startingLength: 6,
    boardScale: 0.85,
  },
  {
    id: "gladiators",
    name: "Gladiators",
    brief: "A tight ARENA, long snakes and nowhere to hide: MOST KILLS wins. Trap rivals against your body and the walls. Big bodies and a bounty make every cut-off pay.",
    objective: "kills",
    foodMod: "normal",
    cutoffAbsorbFraction: 0.5,
    carcassFoodValue: 4,
    startingLength: 8,
    boardScale: 0.7,
  },
  {
    id: "carrion",
    name: "Carrion",
    brief: "Food does NOT feed you — the ONLY way to grow is to cut a rival off and devour the fat carcass they drop. You start LONG so you can actually trap them. Most kills wins.",
    objective: "kills",
    foodMod: "scarce",
    foodGrows: false,
    carcassFoodValue: 8,
    cutoffAbsorbFraction: 0.4,
    startingLength: 9,
    boardScale: 0.8,
  },
  {
    id: "fasting",
    name: "Fasting",
    brief: "INVERTED: stay SMALL. Among the snakes that survive longest, the SHORTEST wins — so AVOID food and resist growing. Eating is a mistake.",
    objective: "fasting",
    foodMod: "normal",
  },
  {
    id: "minimalist",
    name: "Minimalist",
    brief: "Food is EVERYWHERE and you must NOT eat it: among the longest survivors, the SHORTEST snake wins. Thread through the feast without growing.",
    objective: "fasting",
    foodMod: "feast",
  },
  {
    id: "forbidden_orchard",
    name: "Forbidden Orchard",
    brief: "Grow the BIGGEST — but the juicy $ and & fruit is POISON and kills you instantly. Only the small + pellets are safe, so grow patiently and never lunge for the big prize.",
    objective: "grow",
    foodMod: "feast",
    poisonValue: 3,
  },
];

/**
 * Modifiers: orthogonal twists layered ON TOP of a base rule card, drawn 0–2 per
 * round (seeded). Where a card sets the *objective and collision rule*, modifiers
 * reshape the *board and economy* — vision, obstacles, board size, power-ups,
 * shedding, food and special prizes. Stacking a couple of these on a base card
 * yields a large space of distinct situations, so a single hard-coded strategy
 * can't be optimal: an agent has to read the brief and adapt.
 *
 * Every field is an absolute override (or flag) the arena applies when building
 * the round config; `brief` is appended to the announced rules so agents and
 * spectators always know what changed.
 */
export interface Modifier {
  id: string;
  name: string;
  /** Natural-language fragment appended to the round brief. */
  brief: string;
  /** Extra multiplier applied to the food target (on top of the card's). */
  foodMultiplier?: number;
  /** Absolute number of power-up pickups kept on the board. */
  powerUpTarget?: number;
  /** Absolute frenzy duration in ticks. */
  frenzyDurationTicks?: number;
  /** Famine decay period in ticks (0 = off). */
  lengthTaxTicks?: number;
  /** Number of high-value "special" foods spawned at round start. */
  specialFood?: { value: number; count: number };
  /** Fraction of a cut-off victim's length the killer absorbs as growth. */
  cutoffAbsorbFraction?: number;
  /** Growth value of the food each dead segment drops (carcass richness). */
  carcassFoodValue?: number;
  /** Food at/above this value becomes lethal poison. */
  poisonValue?: number;
  /** Modifier ids this one cannot co-occur with. */
  conflicts?: readonly string[];
}

/**
 * Modifiers are orthogonal twists drawn 0–2 per round. We deliberately keep ONLY
 * twists that change how the round is *played* — cosmetic re-skins (walls on/off,
 * board size, vision) were dropped because a flood-fill bot plays them identically.
 * Each of these alters the food economy, the value of hunting, or adds a contested
 * prize, so it interacts with the card's objective rather than just redecorating.
 */
export const MODIFIERS: readonly Modifier[] = [
  {
    id: "bounty",
    name: "Bounty",
    brief: "BOUNTY — cut a rival off (make their head run into your body) and you instantly absorb half their length. Hunting pays.",
    cutoffAbsorbFraction: 0.5,
  },
  {
    id: "rich_carcass",
    name: "Rich Carcass",
    brief: "RICH CARCASS — fallen snakes leave a fat trail of food; whoever made the kill is best placed to feast on it.",
    carcassFoodValue: 5,
  },
  {
    id: "famine",
    name: "Famine",
    brief: "FAMINE — go ~16 ticks without eating and you lose a tail segment; keep feeding or wither away.",
    lengthTaxTicks: 16,
  },
  {
    id: "power_surge",
    name: "Power Surge",
    brief: "POWER SURGE — power-ups (frenzy, ghost, flare, magnet, wall) are everywhere and last longer; grabbing the right one at the right time is a real edge.",
    powerUpTarget: 24,
    frenzyDurationTicks: 55,
  },
  {
    id: "golden_apple",
    name: "Golden Apple",
    brief: "A GOLDEN APPLE (worth +12) has appeared somewhere on the board — a huge contested prize worth fighting over.",
    specialFood: { value: 12, count: 1 },
    conflicts: ["poison"],
  },
  {
    id: "poison",
    name: "Forbidden Fruit",
    brief: "FORBIDDEN FRUIT — the big food ($ and &) is POISON and KILLS you the instant you eat it. Only the small + pellets are safe.",
    poisonValue: 3,
    conflicts: ["golden_apple"],
  },
];

/** Deterministically roll 0–2 non-conflicting modifiers for a round. */
export function rollModifiers(seed: string): Modifier[] {
  const rng = new Rng(`mods:${seed}`);
  // Bias toward variety while keeping plenty of "base card only" rounds.
  const count = rng.pick([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]) ?? 0;
  if (count <= 0) return [];
  const pool = [...MODIFIERS];
  const chosen: Modifier[] = [];
  while (chosen.length < count && pool.length > 0) {
    const i = rng.int(pool.length);
    const mod = pool[i]!;
    pool.splice(i, 1);
    if (chosen.some((c) => c.conflicts?.includes(mod.id) || mod.conflicts?.includes(c.id))) {
      continue;
    }
    chosen.push(mod);
  }
  return chosen;
}

/** Food-target multiplier for a card's food modifier. */
export function foodMultiplier(mod: FoodMod): number {
  switch (mod) {
    case "scarce":
      return 0.35;
    case "feast":
      return 2.2;
    default:
      return 1;
  }
}

/** Deterministically pick a rule card for a round. All cards are equally likely:
 * variety is the point, so no single mode dominates. */
export function pickRuleCard(seed: string): RuleCard {
  const rng = new Rng(`rules:${seed}`);
  return rng.pick([...RULE_CARDS]) ?? RULE_CARDS[0]!;
}
