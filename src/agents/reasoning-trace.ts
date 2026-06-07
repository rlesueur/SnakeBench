import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TraceViewerServer } from "./trace-viewer-server.js";

/**
 * Reasoning tracer — a DEBUG aid for our own LLM harness, not part of the app or
 * the fairness contract. Records every decision as structured JSON and serves a
 * local viewer at http://127.0.0.1:8082/ (override LLM_TRACE_PORT).
 *
 * The arena reports move legality a tick late via `recent_moves`; we join that
 * back to the reasoning that produced each move so illegal submissions are easy
 * to inspect.
 *
 * Output:
 *  - `logs/llm-session-<stamp>.json` — structured session (pretty-printed)
 *  - `logs/llm-trace-<stamp>.jsonl` — append-only log (same events)
 *
 * Disable with LLM_TRACE=0. Pin paths with LLM_TRACE_FILE / LLM_SESSION_FILE.
 */

export interface DecisionTrace {
  tick: number;
  round: string | null;
  laws: { kind: string; title: string; brief: string }[];
  controlRemap: boolean;
  heading: string;
  head: { x: number; y: number };
  move: string | null;
  intent: string | null;
  target: string | null;
  reasoning: string;
  answer: string;
  prompt?: string;
  latencyMs?: number;
}

export type TraceOutcome = "pending" | "legal" | "illegal";

export interface TraceDecision extends DecisionTrace {
  id: number;
  ts: string;
  outcome: TraceOutcome;
}

export interface TraceSession {
  started: string;
  model: string;
  sessionFile: string;
  traceFile: string;
  decisions: TraceDecision[];
}

type RecentMove = { tick: number; move: string; legal: boolean };

const REMAP_KINDS = new Set(["rotate", "mirror"]);
export const isControlRemap = (laws?: { kind: string }[] | null): boolean =>
  !!laws?.some((l) => REMAP_KINDS.has(l.kind));

const tail = (s: string, n: number): string => {
  const clean = (s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > n ? "…" + clean.slice(-n) : clean;
};

export class ReasoningTracer {
  private readonly traceFile: string | null;
  private readonly sessionFile: string | null;
  private readonly session: TraceSession;
  private nextId = 1;
  private readonly byTick = new Map<number, TraceDecision>();
  private readonly flagged = new Set<number>();

  constructor(model = "unknown") {
    if (process.env.LLM_TRACE === "0") {
      this.traceFile = null;
      this.sessionFile = null;
      this.session = { started: "", model, sessionFile: "", traceFile: "", decisions: [] };
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = "logs";
    this.traceFile = process.env.LLM_TRACE_FILE ?? join(dir, `llm-trace-${stamp}.jsonl`);
    this.sessionFile = process.env.LLM_SESSION_FILE ?? join(dir, `llm-session-${stamp}.json`);
    this.session = {
      started: new Date().toISOString(),
      model,
      sessionFile: this.sessionFile,
      traceFile: this.traceFile,
      decisions: [],
    };

    try {
      mkdirSync(dirname(this.traceFile), { recursive: true });
      this.persist();
      console.log(`Reasoning session → ${this.sessionFile}`);
      new TraceViewerServer(() => this.session).start();
    } catch (err) {
      console.error("trace: could not initialise:", (err as Error).message);
    }
  }

  getSession(): TraceSession {
    return this.session;
  }

  private appendLog(obj: unknown): void {
    if (!this.traceFile) return;
    try {
      appendFileSync(this.traceFile, JSON.stringify(obj) + "\n");
    } catch (err) {
      console.error("trace write failed:", (err as Error).message);
    }
  }

  private persist(): void {
    if (!this.sessionFile) return;
    try {
      writeFileSync(this.sessionFile, JSON.stringify(this.session, null, 2));
    } catch (err) {
      console.error("session write failed:", (err as Error).message);
    }
  }

  record(trace: DecisionTrace): void {
    if (!this.sessionFile) return;
    const row: TraceDecision = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      outcome: "pending",
      ...trace,
    };
    this.session.decisions.push(row);
    this.byTick.set(trace.tick, row);
    while (this.byTick.size > 128) {
      const oldest = Math.min(...this.byTick.keys());
      this.byTick.delete(oldest);
    }
    this.appendLog({ type: "decision", ...row });
    this.persist();
  }

  noteOutcomes(recent?: RecentMove[] | null): void {
    if (!this.sessionFile || !recent?.length) return;
    for (const r of recent) {
      const row = this.byTick.get(r.tick);
      if (!row) continue;

      if (r.move === "none") continue;

      if (r.legal) {
        if (row.outcome === "pending") row.outcome = "legal";
        continue;
      }

      if (this.flagged.has(r.tick)) continue;
      this.flagged.add(r.tick);
      row.outcome = "illegal";

      const titles = row.laws.map((l) => l.title).join(", ") || "none";
      console.warn(
        `⚠ tick ${r.tick} ILLEGAL: submitted ${row.move ?? "?"}` +
          (row.controlRemap ? ` under [${titles}]` : "") +
          ` — reasoning tail: ${tail(row.reasoning || row.answer, 220)}`,
      );
      this.appendLog({ type: "illegal_outcome", ...row });
      this.persist();
    }
    if (this.flagged.size > 256) this.flagged.clear();
  }
}
