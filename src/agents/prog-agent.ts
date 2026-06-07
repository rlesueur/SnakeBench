import {
  runAgent,
  type Cell,
  type Decision,
  type Direction,
  type Food,
  type Intent,
  type Rules,
  type State,
} from "./core.js";

/**
 * Programmatic baseline brain — the hand-coded yardstick the LLM is measured
 * against. Unlike the LLM client this one DELIBERATELY does its own work: it runs a
 * flood-fill for free space, projects enemy-head threats, and resolves the move
 * with fixed heuristics keyed off the round's structured objective.
 *
 * It intentionally keys only off the STRUCTURED rule fields (objective / food) and
 * ignores the natural-language "twists" — adapting to those needs genuine reading,
 * which is exactly the gap this prog-vs-LLM comparison is meant to expose.
 *
 * Usage: npm run agent:prog -- [key] [arenaUrl]
 */

const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};
const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

const SPACE_CAP = 150; // cap on flood-fill exploration (keeps it cheap)
type HeadToHead = "longest" | "shortest" | "all_die";

/** All cells that would kill the snake on contact this tick. */
function buildBlocked(state: State): Set<string> {
  const b = new Set<string>();
  for (const o of state.obstacles ?? []) b.add(`${o.x},${o.y}`);
  for (const c of state.you.body) b.add(`${c.x},${c.y}`);
  for (const s of state.snakes) for (const c of s.body) b.add(`${c.x},${c.y}`);
  return b;
}

/** Count free cells reachable from `start` (4-connected), capped at SPACE_CAP. */
function reachableSpace(state: State, start: Cell, blocked: Set<string>): number {
  const { width, height } = state.world;
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const queue: Cell[] = [start];
  let count = 0;
  while (queue.length && count < SPACE_CAP) {
    const c = queue.shift()!;
    count += 1;
    for (const d of DIRECTIONS) {
      const nx = c.x + DELTA[d].x;
      const ny = c.y + DELTA[d].y;
      const k = `${nx},${ny}`;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return count;
}

/** Cells an enemy head could enter next tick -> the shortest and longest such
 * enemy (so head-to-head danger can be judged under any rule). */
function contestedCells(state: State): Map<string, { min: number; max: number }> {
  const m = new Map<string, { min: number; max: number }>();
  for (const s of state.snakes) {
    for (const d of DIRECTIONS) {
      const k = `${s.head.x + DELTA[d].x},${s.head.y + DELTA[d].y}`;
      const cur = m.get(k);
      if (!cur) m.set(k, { min: s.length, max: s.length });
      else {
        cur.min = Math.min(cur.min, s.length);
        cur.max = Math.max(cur.max, s.length);
      }
    }
  }
  return m;
}

/** Would entering a cell contested by an enemy head lose us the head-to-head? */
function losesHeadToHead(
  threat: { min: number; max: number } | undefined,
  selfLength: number,
  mode: HeadToHead,
): boolean {
  if (!threat) return false;
  if (mode === "all_die") return true; // any clash kills us
  if (mode === "shortest") return threat.min <= selfLength; // a same-or-shorter enemy wins
  return threat.max >= selfLength; // longest-wins: a same-or-longer enemy wins
}

type MoveStatus = "ILLEGAL" | "DEADLY" | "RISKY" | "SAFE";
interface MoveFact {
  dir: Direction;
  status: MoveStatus;
  reason: string;
  space: number | null;
}

function analyseMoves(state: State, mode: HeadToHead): MoveFact[] {
  const { head, heading, body, length } = state.you;
  const banned = body.length > 1 ? OPPOSITE[heading] : null;
  const blocked = buildBlocked(state);
  const contested = contestedCells(state);
  const { width, height } = state.world;

  return DIRECTIONS.map((d): MoveFact => {
    if (d === banned) {
      return { dir: d, status: "ILLEGAL", reason: "would reverse into your neck", space: null };
    }
    const n = { x: head.x + DELTA[d].x, y: head.y + DELTA[d].y };
    if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= height) {
      return { dir: d, status: "DEADLY", reason: "hits the wall", space: null };
    }
    if (blocked.has(`${n.x},${n.y}`)) {
      return { dir: d, status: "DEADLY", reason: "hits a snake or obstacle", space: null };
    }
    const space = reachableSpace(state, n, blocked);
    const cap = space >= SPACE_CAP ? "+" : "";
    const threat = contested.get(`${n.x},${n.y}`);
    if (losesHeadToHead(threat, length, mode)) {
      const why =
        mode === "all_die"
          ? "an enemy head could move here -> clash kills BOTH of you"
          : mode === "shortest"
            ? `a same-or-shorter enemy (len ${threat?.min}) could move here -> you lose (shorter wins)`
            : `a same-or-longer enemy (len ${threat?.max} >= you ${length}) could move here -> head-to-head loss`;
      return { dir: d, status: "RISKY", reason: why, space };
    }
    if (space < length) {
      return {
        dir: d,
        status: "RISKY",
        reason: `cramped: only ~${space}${cap} cells of room (< your length ${length}) -> may trap yourself`,
        space,
      };
    }
    return { dir: d, status: "SAFE", reason: `open: ~${space}${cap} cells of room`, space };
  });
}

function programmaticDecision(state: State, rules: Rules | null): Decision {
  const mode: HeadToHead = "longest";
  const analysis = analyseMoves(state, mode);
  const rank: Record<MoveStatus, number> = { SAFE: 0, RISKY: 1, DEADLY: 2, ILLEGAL: 3 };
  const usable = analysis.filter((f) => f.status !== "ILLEGAL");
  const bestTier = usable.length ? Math.min(...usable.map((f) => rank[f.status])) : 3;
  const pool = (usable.length ? usable : analysis).filter((f) => rank[f.status] === bestTier);

  const { head } = state.you;
  const dist = (c: Cell): number => Math.abs(c.x - head.x) + Math.abs(c.y - head.y);
  const cellAfter = (d: Direction): Cell => ({ x: head.x + DELTA[d].x, y: head.y + DELTA[d].y });

  // Best food: highest value, nearest as tiebreak.
  let food: Food | null = null;
  for (const f of state.food) {
    if (!food || f.value > food.value || (f.value === food.value && dist(f) < dist(food))) food = f;
  }
  // Nearest enemy head (for the "kills" objective).
  let enemy: Cell | null = null;
  for (const s of state.snakes) {
    if (!enemy || dist(s.head) < dist(enemy)) enemy = s.head;
  }

  const objective = rules?.objective ?? "survive";
  const towardFood = food && (objective === "grow" || rules?.food === "scarce");
  const towardEnemy = objective === "kills" && enemy;

  const score = (f: MoveFact): number => {
    const n = cellAfter(f.dir);
    const space = f.space ?? 0;
    if (towardEnemy && enemy) {
      const closer = dist(enemy) - (Math.abs(n.x - enemy.x) + Math.abs(n.y - enemy.y));
      return closer * 100 + space; // close on the rival, break ties by room
    }
    if (towardFood && food) {
      const closer = dist(food) - (Math.abs(n.x - food.x) + Math.abs(n.y - food.y));
      return closer * 1000 + space; // strongly prefer moving toward food, break ties by room
    }
    return space; // survive: maximise room
  };
  let best = pool[0]!;
  for (const f of pool) if (score(f) > score(best)) best = f;

  // Derive a coherent intent from the chosen move and situation.
  const n = cellAfter(best.dir);
  let intent: Intent;
  let target: string | null = null;
  if (bestTier >= 2) intent = "escaping"; // forced into a deadly cell — no good option
  else if (bestTier === 1) intent = "evading"; // only risky moves available
  else if (towardEnemy && enemy && dist(enemy) - (Math.abs(n.x - enemy.x) + Math.abs(n.y - enemy.y)) > 0) {
    intent = "hunting";
    target = "nearest rival";
  } else if (towardFood && food && dist(food) - (Math.abs(n.x - food.x) + Math.abs(n.y - food.y)) > 0) {
    intent = "feeding";
    target = food.value >= 6 ? "high-value food" : "food";
  } else intent = "roaming";

  return { move: best.dir, intent, target, log: { analysis } };
}

runAgent({
  name: "programmatic",
  banner: "brain=programmatic (no model)",
  decide: (obs) => programmaticDecision(obs.state, obs.rules),
});
