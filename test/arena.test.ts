import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASELINE_ROSTER } from "../src/npc/baselines.js";
import { Arena, type AgentSession } from "../src/server/arena.js";
import { DEFAULT_CONFIG, DEFAULT_SERVER_CONFIG } from "../src/config.js";

/** A fake agent connection that records every message the arena sends it. */
function fakeAgent(id: string): AgentSession & { inbox: any[] } {
  const inbox: any[] = [];
  return {
    snakeId: id,
    displayName: id,
    alive: true,
    pendingMove: null,
    lastView: null,
    lastViewTick: -1,
    lastSentAt: 0,
    inbox,
    send: (m: unknown) => inbox.push(m),
  };
}

describe("arena round lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a round, streams state, and ends it, messaging agents and spectators", () => {
    const spectator: any[] = [];
    // No obstacles and a one-tick cap so two idle snakes (spawned well apart and
    // ≥3 cells from any wall) cannot die in the single tick — the round
    // deterministically ends by the time cap regardless of the random seed.
    const arena = new Arena(
      { broadcastSpectators: (m) => spectator.push(m) },
      { ...DEFAULT_CONFIG, tickDeadlineMs: 10, maxTicks: 1, obstacleDensity: 0 },
      { ...DEFAULT_SERVER_CONFIG, minSnakes: 2, npcFloor: 0, roundRestartDelayMs: 1_000_000, joinGraceMs: 1 },
      null,
      null,
    );

    const a = fakeAgent("alice");
    const b = fakeAgent("bob");
    arena.addAgent(a);
    arena.addAgent(b);

    arena.start();

    // round_start + an initial state should be delivered immediately.
    expect(a.inbox.some((m) => m.type === "round_start")).toBe(true);
    expect(a.inbox.some((m) => m.type === "state")).toBe(true);
    expect(spectator.some((m) => m.type === "round_start")).toBe(true);

    // Drive ticks until the time cap (maxTicks=1) ends the round.
    vi.advanceTimersByTime(60);

    const end = a.inbox.find((m) => m.type === "round_end");
    expect(end).toBeTruthy();
    expect(end.reason).toBe("time_limit");
    expect(Array.isArray(end.standings)).toBe(true);
    expect(end.standings.length).toBe(5); // 2 agents + 3 fixed baselines

    // Spectator frames carry the events + notes channels (arrays, possibly empty).
    const frame = spectator.find((m) => m.type === "frame");
    expect(frame).toBeTruthy();
    expect(Array.isArray(frame.events)).toBe(true);
    expect(Array.isArray(frame.notes)).toBe(true);

    arena.stop();
  });

  it("always includes the three baseline NPCs, even with no agents connected", () => {
    const spectator: any[] = [];
    const arena = new Arena(
      { broadcastSpectators: (m) => spectator.push(m) },
      { ...DEFAULT_CONFIG, tickDeadlineMs: 10, maxTicks: 1, obstacleDensity: 0 },
      { ...DEFAULT_SERVER_CONFIG, minSnakes: 3, ambientTickMs: 10, ambientMaxTicks: 1, roundRestartDelayMs: 1_000_000 },
      null,
      null,
    );

    arena.start();

    const frame = spectator.find((m) => m.type === "frame");
    expect(frame).toBeTruthy();
    const names = new Set(frame.frame.snakes.map((s: { displayName: string }) => s.displayName));
    for (const b of BASELINE_ROSTER) expect(names.has(b.displayName)).toBe(true);

    vi.advanceTimersByTime(60);
    const end = spectator.find((m) => m.type === "round_end");
    expect(end?.standings?.length).toBe(3);

    arena.stop();
  });

  it("ignores stale-tick actions but accepts current-tick moves", () => {
    const arena = new Arena(
      { broadcastSpectators: () => {} },
      { ...DEFAULT_CONFIG, tickDeadlineMs: 10, maxTicks: 50 },
      { ...DEFAULT_SERVER_CONFIG, minSnakes: 1, npcFloor: 0, roundRestartDelayMs: 1_000_000 },
      null,
      null,
    );
    const a = fakeAgent("solo");
    arena.addAgent(a);
    arena.start();

    arena.submitAction("solo", 999, "up");
    expect(a.pendingMove).toBeNull(); // stale tick rejected

    arena.submitAction("solo", 0, "up");
    expect(a.pendingMove).toBe("up"); // current tick accepted

    arena.stop();
  });
});
