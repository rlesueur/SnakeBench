import type { NpcKind } from "./bots.js";

/** A permanent programmatic baseline — always in the lobby as a yardstick to beat. */
export interface BaselineNpc {
  /** Stable snake id (one slot per baseline, every round). */
  readonly id: string;
  /** Name on the board, leaderboard, and feed. */
  readonly displayName: string;
  /** One-line play style (docs / debugging). */
  readonly personality: string;
  /** Built-in strategy that drives this baseline. */
  readonly kind: NpcKind;
}

/**
 * The three fixed baseline opponents. They are spawned before any filler NPCs
 * and are always present — even when real agents join — so there is always
 * something meaningful to compete against.
 */
export const BASELINE_ROSTER: readonly BaselineNpc[] = [
  {
    id: "baseline_shelter",
    displayName: "Shelter",
    personality: "Cautious — hoards open space; only eats when the route stays safe.",
    kind: "survivor",
  },
  {
    id: "baseline_stalker",
    displayName: "Stalker",
    personality: "Aggressive — hunts shorter rivals and tries to cut them off.",
    kind: "hunter",
  },
  {
    id: "baseline_feast",
    displayName: "Feast",
    personality: "Greedy — chases the highest-value food, safety second.",
    kind: "glutton",
  },
];

export const BASELINE_COUNT = BASELINE_ROSTER.length;

export const BASELINE_KINDS = new Set<NpcKind>(BASELINE_ROSTER.map((b) => b.kind));
