/**
 * Per-round "laws": natural-language rules, enforced server-side, that change how
 * a move is interpreted, which moves are legal, or what cells mean. Unlike the
 * objective cards (which reshape the *scoreboard*), a law changes the **dynamics**
 * — the optimal policy itself — so a generic greedy / flood-fill program plays it
 * wrongly unless it reads the round's prose and reasons about it. The win
 * condition stays simple (survive longest, length as tiebreak); the difficulty
 * moves into *moving correctly at all*.
 *
 * Three categories, all enforced at the `step()` move chokepoint:
 *  - transform  — remap the submitted direction before it is applied (rotate, mirror);
 *  - constraint — judge the resulting move legal or not; illegal = death ("unlawful")
 *                 (no_turn, cadence, confine);
 *  - semantic   — reinterpret what cells mean when the head enters them (inversion).
 *
 * The agent is told each law and its parameters ONLY in the natural-language
 * render — we deliberately do not ship a clean machine-switchable spec — so a
 * baseline that keys off the old structured fields ignores laws and fails.
 */
import { type Cell, type Direction, OPPOSITE } from "../types.js";

export type LawKind = "rotate" | "mirror" | "no_turn" | "cadence" | "confine" | "inversion";

/** Which broad mechanic a law belongs to (used when rolling so a round draws at
 * most one law per category). */
export type LawCategory = "transform" | "constraint" | "semantic";

interface LawBase {
  kind: LawKind;
  category: LawCategory;
  /** Short label for pills / feeds, e.g. "Rotated controls". */
  title: string;
  /** Natural-language description shown to the model (the only place a law's
   * parameters are revealed). */
  brief: string;
}

/** Transform: the submitted direction is turned `quarters` × 90° clockwise. */
export interface RotateLaw extends LawBase {
  kind: "rotate";
  category: "transform";
  quarters: 1 | 2 | 3;
}

/** Transform: one axis of control is mirrored before the move applies. */
export interface MirrorLaw extends LawBase {
  kind: "mirror";
  category: "transform";
  axis: "horizontal" | "vertical";
}

/** Constraint: you may only continue straight or turn one way; the banned turn
 * is fatal. */
export interface NoTurnLaw extends LawBase {
  kind: "no_turn";
  category: "constraint";
  banned: "left" | "right";
}

/** Constraint: on every `every`-th tick you must move strictly closer to the
 * anchor cell, or you die. */
export interface CadenceLaw extends LawBase {
  kind: "cadence";
  category: "constraint";
  every: number;
  anchor: Cell;
}

/** Constraint: leaving the marked rectangle is fatal. */
export interface ConfineLaw extends LawBase {
  kind: "confine";
  category: "constraint";
  rect: { x: number; y: number; w: number; h: number };
}

/** Semantic: obstacles become harmless to enter, but food at/above `lethalFood`
 * is deadly to eat — a true danger-map flip. */
export interface InversionLaw extends LawBase {
  kind: "inversion";
  category: "semantic";
  lethalFood: number;
}

export type Law = RotateLaw | MirrorLaw | NoTurnLaw | CadenceLaw | ConfineLaw | InversionLaw;

/** Clockwise order of headings, so rotation is index arithmetic. */
const CW: readonly Direction[] = ["up", "right", "down", "left"];

function rotateDir(dir: Direction, quarters: number): Direction {
  const i = CW.indexOf(dir);
  return CW[(i + quarters) % 4]!;
}

function mirrorDir(dir: Direction, axis: "horizontal" | "vertical"): Direction {
  if (axis === "horizontal") {
    return dir === "left" ? "right" : dir === "right" ? "left" : dir;
  }
  return dir === "up" ? "down" : dir === "down" ? "up" : dir;
}

/** Apply every transform law (in order) to a submitted direction, yielding the
 * real heading the engine should move. Non-transform laws are ignored here. */
export function applyTransform(submitted: Direction, laws: readonly Law[]): Direction {
  let d = submitted;
  for (const law of laws) {
    if (law.kind === "rotate") d = rotateDir(d, law.quarters);
    else if (law.kind === "mirror") d = mirrorDir(d, law.axis);
  }
  return d;
}

/** Undo transform laws so a bot can pick the screen-space move it wants and
 * convert it into the direction it must submit. Mirror is self-inverse; rotate
 * inverts by turning the other way. */
export function invertTransform(intended: Direction, laws: readonly Law[]): Direction {
  let d = intended;
  for (let i = laws.length - 1; i >= 0; i--) {
    const law = laws[i]!;
    if (law.kind === "rotate") {
      const q = ((4 - law.quarters) % 4) as 1 | 2 | 3;
      d = rotateDir(d, q);
    } else if (law.kind === "mirror") {
      d = mirrorDir(d, law.axis);
    }
  }
  return d;
}

/** Relative turn taken when heading changes from `prev` to `next`. */
function turnOf(prev: Direction, next: Direction): "straight" | "left" | "right" | "back" {
  if (next === prev) return "straight";
  if (next === OPPOSITE[prev]) return "back";
  const i = CW.indexOf(prev);
  return CW[(i + 1) % 4] === next ? "right" : "left";
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Context for judging a single snake's move against the constraint laws. */
export interface MoveJudgement {
  /** Head cell before the move. */
  prevHead: Cell;
  /** Heading before the move. */
  prevHeading: Direction;
  /** The real heading after transforms + the neck-reversal guard. */
  heading: Direction;
  /** Head cell after the move. */
  newHead: Cell;
  /** Current tick (the move resolves into tick+1). */
  tick: number;
}

/** Return the constraint law a move violates, or null if the move is legal. A
 * violation is fatal (death cause "unlawful"). Transform and semantic laws are
 * not judged here. */
export function constraintViolation(laws: readonly Law[], ctx: MoveJudgement): Law | null {
  for (const law of laws) {
    if (law.kind === "no_turn") {
      if (turnOf(ctx.prevHeading, ctx.heading) === law.banned) return law;
    } else if (law.kind === "confine") {
      const { x, y, w, h } = law.rect;
      const inside =
        ctx.newHead.x >= x && ctx.newHead.x < x + w && ctx.newHead.y >= y && ctx.newHead.y < y + h;
      if (!inside) return law;
    } else if (law.kind === "cadence") {
      if (ctx.tick > 0 && ctx.tick % law.every === 0) {
        const before = manhattan(ctx.prevHead, law.anchor);
        if (before > 0 && manhattan(ctx.newHead, law.anchor) >= before) return law;
      }
    }
  }
  return null;
}

/** Under inversion, obstacle cells are harmless to enter. */
export function obstaclesPassable(laws: readonly Law[]): boolean {
  return laws.some((l) => l.kind === "inversion");
}

/** Food value at/above which eating is lethal this round (from an inversion law),
 * or null if no such law is active. */
export function lethalFoodValue(laws: readonly Law[]): number | null {
  for (const l of laws) if (l.kind === "inversion") return l.lethalFood;
  return null;
}

// --- construction (params -> full law with prose) ---------------------------

function rotate(quarters: 1 | 2 | 3): RotateLaw {
  const brief =
    quarters === 2
      ? "Reversed controls (180°): the input you submit is flipped to its opposite before it applies. Submit up→you TRAVEL down, down→up, left→right, right→left. So to travel a given way, submit its opposite: to go up submit down, to go down submit up, to go left submit right, to go right submit left."
      : quarters === 1
        ? "Rotated controls (90° clockwise): the input you submit is turned a quarter-turn clockwise before it applies. Submit up→you TRAVEL right, right→down, down→left, left→up. So to travel a given way, submit a quarter-turn ANTIclockwise of it: to go up submit left, to go right submit up, to go down submit right, to go left submit down."
        : "Rotated controls (90° anticlockwise): the input you submit is turned a quarter-turn anticlockwise before it applies. Submit up→you TRAVEL left, left→down, down→right, right→up. So to travel a given way, submit a quarter-turn CLOCKWISE of it: to go up submit right, to go right submit down, to go down submit left, to go left submit up.";
  return { kind: "rotate", category: "transform", title: "Rotated controls", brief, quarters };
}

function mirror(axis: "horizontal" | "vertical"): MirrorLaw {
  const brief =
    axis === "horizontal"
      ? "Mirrored controls (left–right swapped): submit left→you TRAVEL right, right→left; up and down are unchanged. So to go left submit right, and to go right submit left."
      : "Mirrored controls (up–down swapped): submit up→you TRAVEL down, down→up; left and right are unchanged. So to go up submit down, and to go down submit up.";
  return { kind: "mirror", category: "transform", title: "Mirrored controls", brief, axis };
}

function noTurn(banned: "left" | "right"): NoTurnLaw {
  const other = banned === "left" ? "right" : "left";
  const brief = `One-way turns: you may not turn ${banned}. Each tick you may only continue straight or turn ${other}; attempting to turn ${banned} is fatal.`;
  return { kind: "no_turn", category: "constraint", title: "One-way turns", brief, banned };
}

function cadence(every: number, anchor: Cell): CadenceLaw {
  const brief = `Tidal pull: on every ${every}th tick (ticks that are exact multiples of ${every}) you must move strictly closer to the beacon at (${anchor.x}, ${anchor.y}); failing to close the distance on those ticks is fatal. On all other ticks you move freely.`;
  return { kind: "cadence", category: "constraint", title: "Tidal pull", brief, every, anchor };
}

function confine(rect: { x: number; y: number; w: number; h: number }): ConfineLaw {
  const brief = `Confinement: you must stay inside the box covering x ${rect.x}..${rect.x + rect.w - 1}, y ${rect.y}..${rect.y + rect.h - 1}. Moving your head outside that box is fatal.`;
  return { kind: "confine", category: "constraint", title: "Confinement", brief, rect };
}

function inversion(lethalFood: number): InversionLaw {
  const brief = `Inverted world: the usual dangers and prizes are flipped. Walls/obstacles (#) are harmless to move through, but eating large food (value ${lethalFood} or more, shown as &) is instantly fatal. Small food is still safe.`;
  return { kind: "inversion", category: "semantic", title: "Inverted world", brief, lethalFood };
}

export const LAW_BUILDERS = { rotate, mirror, noTurn, cadence, confine, inversion };
