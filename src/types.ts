export type Direction = "up" | "down" | "left" | "right";

export const DIRECTIONS: readonly Direction[] = ["up", "down", "left", "right"];

export interface Cell {
  x: number;
  y: number;
}

/** Direction unit vectors. y increases downward (row index). */
export const DELTA: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

export interface Snake {
  id: string;
  displayName: string;
  isNpc: boolean;
  alive: boolean;
  heading: Direction;
  /** body[0] is the head, last element is the tail. */
  body: Cell[];
  /** Remaining segments still to be added from food eaten (gradual growth). */
  pendingGrowth: number;
  /** Current combo streak (consecutive-tick eating). */
  comboLevel: number;
  /** Tick on which this snake last ate. */
  lastAteTick: number;
  /** Ticks spent with the head inside the round's scoring zone ("zone" objective). */
  zoneTicks: number;
  /** Index of the next relay waypoint this snake is heading for ("relay" objective). */
  waypointIndex: number;
  /** Largest length reached so far — the match metric. */
  peakSize: number;
  /** Tick at which the snake died, or null if alive. */
  diedAtTick: number | null;
}

/** A submitted action for a given tick. */
export interface Action {
  snakeId: string;
  move: Direction;
}

export function key(x: number, y: number): string {
  return `${x},${y}`;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y}`;
}

export function size(snake: Snake): number {
  return snake.body.length;
}
