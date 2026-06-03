import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_CONFIG, DEFAULT_SERVER_CONFIG } from "../config.js";
import { Arena } from "./arena.js";
import { loadAgentKeys } from "./auth.js";
import { StatsStore } from "./stats.js";
import { LogStore } from "./logs.js";
import { UserStore } from "./users.js";
import { closePool, migrate } from "./db.js";
import {
  clearSessionCookie,
  getSessionUserId,
  setSessionCookie,
  setStateCookie,
  verifyStateCookie,
} from "./sessions.js";
import * as google from "./google-oauth.js";

const config = { ...DEFAULT_CONFIG };
const serverConfig = { ...DEFAULT_SERVER_CONFIG };

if (process.env.TICK_MS) config.tickDeadlineMs = Number(process.env.TICK_MS);
if (process.env.PORT) serverConfig.port = Number(process.env.PORT);

// Operational safeguards (cost-spike protection).
const MAX_SPECTATORS = Number(process.env.MAX_SPECTATORS) || 200;
const SPECTATOR_MAX_FPS = Number(process.env.SPECTATOR_MAX_FPS) || 8;
const AGENT_IDLE_MS = Number(process.env.AGENT_IDLE_MS) || 60_000;
const ALLOW_STATIC_KEYS = process.env.ALLOW_STATIC_KEYS === "1";

const users = new UserStore();
// Static keys remain available only as an explicit dev/admin escape hatch.
const staticKeys = ALLOW_STATIC_KEYS ? loadAgentKeys() : new Map();

interface Identity {
  userId: string | null;
  displayName: string;
}

/** Resolve a presented key: static keys (if enabled) first, then hashed DB keys. */
async function resolveIdentity(key: string | null | undefined): Promise<Identity | null> {
  if (!key) return null;
  const stat = staticKeys.get(key);
  if (stat) return { userId: null, displayName: stat.displayName };
  const found = await users.findKey(key);
  return found ? { userId: found.userId, displayName: found.displayName } : null;
}

// --- spectator broadcast (with FPS throttle) --------------------------------
const spectators = new Set<WebSocket>();
let lastFrameAt = 0;
function broadcastSpectators(msg: unknown): void {
  const isFrame = (msg as { type?: string }).type === "frame";
  if (isFrame) {
    const now = Date.now();
    if (now - lastFrameAt < 1000 / SPECTATOR_MAX_FPS) return; // drop to cap egress
    lastFrameAt = now;
  }
  const data = JSON.stringify(msg);
  for (const ws of spectators) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

const stats = new StatsStore();
const logs = new LogStore();
const arena = new Arena({ broadcastSpectators }, config, serverConfig, stats, logs);

// --- tiny per-IP rate limiter -----------------------------------------------
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
function clientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf) return xf.split(",")[0]!.trim();
  return req.socket.remoteAddress || "unknown";
}

// --- HTTP helpers -----------------------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolveBody(body));
    req.on("error", () => resolveBody(""));
  });
}
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
async function requireUser(req: IncomingMessage, res: ServerResponse) {
  const uid = getSessionUserId(req);
  if (!uid) {
    sendJson(res, 401, { error: "Not signed in." });
    return null;
  }
  const user = await users.getUser(uid);
  if (!user) {
    clearSessionCookie(res);
    sendJson(res, 401, { error: "Session invalid." });
    return null;
  }
  return user;
}

const PUBLIC_DIR = resolve("public");
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const ip = clientIp(req);

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  if (path === "/api/leaderboard") {
    sendJson(res, 200, arena.leaderboard());
    return;
  }

  // --- OAuth -----------------------------------------------------------------
  if (path === "/auth/google" && method === "GET") {
    if (!google.isConfigured()) {
      sendJson(res, 503, { error: "Google sign-in is not configured on this server." });
      return;
    }
    if (!rateLimit(`auth:${ip}`, 20)) {
      sendJson(res, 429, { error: "Too many requests." });
      return;
    }
    const state = randomBytes(16).toString("hex");
    setStateCookie(res, state);
    res.writeHead(302, { location: google.authUrl(state) }).end();
    return;
  }

  if (path === "/auth/google/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    if (!code || !verifyStateCookie(req, state)) {
      res.writeHead(400, { "content-type": "text/html" }).end("<p>Sign-in failed (bad state). <a href='/account.html'>Try again</a>.</p>");
      return;
    }
    try {
      const token = await google.exchangeCode(code);
      const profile = await google.fetchProfile(token);
      const user = await users.upsertOAuthUser("google", profile.sub, profile.email, profile.name);
      setSessionCookie(res, user.id);
      res.writeHead(302, { location: "/account.html" }).end();
    } catch (err) {
      console.error("OAuth callback error:", (err as Error).message);
      res.writeHead(502, { "content-type": "text/html" }).end("<p>Sign-in failed. <a href='/account.html'>Try again</a>.</p>");
    }
    return;
  }

  if (path === "/auth/logout" && method === "POST") {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- account (session) -----------------------------------------------------
  if (path === "/api/me") {
    const user = await requireUser(req, res);
    if (!user) return;
    if (method === "POST") {
      if (!rateLimit(`rename:${user.id}`, 10)) {
        sendJson(res, 429, { error: "Too many requests." });
        return;
      }
      let displayName = "";
      try {
        displayName = (JSON.parse(await readBody(req)) as { displayName?: string }).displayName ?? "";
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      const result = await users.rename(user.id, displayName);
      sendJson(res, result.ok ? 200 : 409, result.ok ? { ok: true, displayName } : { error: result.error });
      return;
    }
    const board = arena.leaderboard() as Array<{ account: string }>;
    const mine = board.find((s) => s.account === user.displayName) ?? null;
    sendJson(res, 200, {
      account: user.displayName,
      email: user.email,
      keys: await users.listKeys(user.id),
      stats: mine,
    });
    return;
  }

  // --- API keys (session) ----------------------------------------------------
  if (path === "/api/keys") {
    const user = await requireUser(req, res);
    if (!user) return;
    if (method === "GET") {
      sendJson(res, 200, { keys: await users.listKeys(user.id) });
      return;
    }
    if (method === "POST") {
      if (!rateLimit(`key:${user.id}`, 10)) {
        sendJson(res, 429, { error: "Too many requests." });
        return;
      }
      let label = "";
      try {
        label = (JSON.parse((await readBody(req)) || "{}") as { label?: string }).label ?? "";
      } catch {
        label = "";
      }
      const result = await users.createKey(user.id, label);
      sendJson(res, result.ok ? 201 : 409, result.ok
        ? { key: result.key, prefix: result.prefix, note: "Store this key now — it is shown only once." }
        : { error: result.error });
      return;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { error: "Key id required." });
        return;
      }
      const ok = await users.revokeKey(user.id, id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found." });
      return;
    }
    sendJson(res, 405, { error: "Use GET, POST or DELETE." });
    return;
  }

  // --- decision logs (session) ----------------------------------------------
  if (path === "/api/logs") {
    const user = await requireUser(req, res);
    if (!user) return;
    if (method === "GET") {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      sendJson(res, 200, {
        account: user.displayName,
        total: await logs.count(user.displayName),
        entries: await logs.read(user.displayName, limit),
      });
      return;
    }
    if (method === "DELETE") {
      const removed = await logs.clear(user.displayName);
      sendJson(res, 200, { account: user.displayName, deleted: removed });
      return;
    }
    sendJson(res, 405, { error: "Use GET or DELETE." });
    return;
  }

  // The onboarding guide (SKILL.md), served raw for the in-page renderer.
  if (path === "/api/guide") {
    const guide = resolve("SKILL.md");
    if (!existsSync(guide)) {
      res.writeHead(404).end("guide not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(readFileSync(guide));
    return;
  }

  // Static files from public/.
  const file = path === "/" ? "spectator.html" : path.replace(/^\/+/, "");
  const full = resolve(PUBLIC_DIR, file);
  if (full.startsWith(PUBLIC_DIR) && existsSync(full)) {
    const type = file.endsWith(".html") ? "text/html" : "text/plain";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(full));
    return;
  }
  res.writeHead(404).end("Not found");
});

const agentWss = new WebSocketServer({ noServer: true });
const spectatorWss = new WebSocketServer({ noServer: true });

let agentCounter = 0;

httpServer.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/agent") {
    const identity = await resolveIdentity(url.searchParams.get("key"));
    if (!identity) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit("connection", ws, identity.displayName);
    });
  } else if (url.pathname === "/spectate") {
    if (spectators.size >= MAX_SPECTATORS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    spectatorWss.handleUpgrade(req, socket, head, (ws) => {
      spectatorWss.emit("connection", ws);
    });
  } else {
    socket.destroy();
  }
});

agentWss.on("connection", (ws: WebSocket, displayName: string) => {
  agentCounter += 1;
  const snakeId = `agent_${displayName}_${agentCounter}`;
  const session = {
    snakeId,
    displayName,
    alive: true,
    pendingMove: null,
    pendingShed: false,
    lastView: null,
    lastViewTick: -1,
    lastSentAt: 0,
    send: (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };

  // Idle-timeout: drop agents that stop sending actions, to free resources.
  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(4002, "idle timeout"), AGENT_IDLE_MS);
  };
  resetIdle();

  session.send({ type: "welcome", you_id: snakeId, config });
  arena.addAgent(session);
  console.log(`Agent connected: ${snakeId}`);

  ws.on("message", (raw) => {
    resetIdle();
    let msg: { type?: string; tick?: number; move?: string; shed?: boolean; log?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "action" && typeof msg.tick === "number" && typeof msg.move === "string") {
      arena.submitAction(snakeId, msg.tick, msg.move, msg.shed === true, msg.log ?? null);
    }
  });

  ws.on("close", () => {
    clearTimeout(idleTimer);
    arena.removeAgent(snakeId);
    console.log(`Agent disconnected: ${snakeId}`);
  });
});

spectatorWss.on("connection", (ws: WebSocket) => {
  spectators.add(ws);
  const init = arena.currentFrame();
  if (init) ws.send(JSON.stringify({ type: "init", ...init }));
  ws.send(JSON.stringify({ type: "leaderboard", board: arena.leaderboard() }));
  ws.on("close", () => spectators.delete(ws));
});

async function main(): Promise<void> {
  await migrate();
  await stats.init();
  httpServer.listen(serverConfig.port, () => {
    arena.start();
    console.log(`\nArena running on http://localhost:${serverConfig.port}`);
    console.log(`  Spectator view:  http://localhost:${serverConfig.port}/`);
    console.log(`  Account:         http://localhost:${serverConfig.port}/account.html`);
    console.log(`  Agent WS:        ws://localhost:${serverConfig.port}/agent?key=YOUR_KEY`);
    console.log(`  Google sign-in:  ${google.isConfigured() ? "configured" : "NOT configured"}`);
    console.log(`  Tick deadline:   ${config.tickDeadlineMs} ms\n`);
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down.`);
  arena.stop();
  for (const ws of spectators) ws.close();
  httpServer.close();
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
