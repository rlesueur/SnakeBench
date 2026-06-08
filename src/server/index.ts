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
import { closePool, migrate, query } from "./db.js";
import {
  clearSessionCookie,
  clearStateCookie,
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
if (process.env.MAX_AGENTS_PER_ROUND) serverConfig.maxAgentsPerRound = Number(process.env.MAX_AGENTS_PER_ROUND);

// Operational safeguards (cost-spike protection).
const MAX_SPECTATORS = Number(process.env.MAX_SPECTATORS) || 200;
// Per-IP concurrent spectator cap, so one client cannot exhaust all slots.
const SPECTATOR_PER_IP = Number(process.env.SPECTATOR_PER_IP) || 8;
// Per-IP agent-handshake attempts per minute (DoS / brute-force friction).
const AGENT_HANDSHAKES_PER_MIN = Number(process.env.AGENT_HANDSHAKES_PER_MIN) || 120;
const SPECTATOR_MAX_FPS = Number(process.env.SPECTATOR_MAX_FPS) || 8;
const AGENT_IDLE_MS = Number(process.env.AGENT_IDLE_MS) || 30_000;
// Max inbound agent WS messages per connection per minute (JSON frames, any type).
const AGENT_MSGS_PER_MIN = Number(process.env.AGENT_MSGS_PER_MIN) || 120;
// Global cap on distinct agent WebSocket connections (one per account).
const MAX_AGENT_CONNECTIONS = Number(process.env.MAX_AGENT_CONNECTIONS) || 100;
const ALLOW_STATIC_KEYS = process.env.ALLOW_STATIC_KEYS === "1";

const users = new UserStore();
// Static keys remain available only as an explicit dev/admin escape hatch.
const staticKeys = ALLOW_STATIC_KEYS ? loadAgentKeys() : new Map();

interface Identity {
  userId: string | null;
  displayName: string;
}

/** Extract a bearer token from the Authorization header (agents authenticate
 * with `Authorization: Bearer <key>`; keys are never placed in the URL). */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
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
const spectatorsByIp = new Map<string, number>();
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
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req: IncomingMessage): string {
  // Only trust the proxy-supplied client address when explicitly configured;
  // otherwise the header is spoofable and lets clients evade rate limits.
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf) return xf.split(",")[0]!.trim();
  }
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

/** Defence-in-depth headers applied to every HTTP response. CSP keeps
 * 'unsafe-inline' because the pages bundle inline script/style/SVG; tightening
 * to nonces/external files is noted as future work. */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
}

/** Reject cross-origin state-changing requests (defence-in-depth beyond
 * SameSite=Lax cookies). Only acts when an Origin/Referer host is present and
 * does not match the request's Host. */
function sameOriginOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return true;
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true; // non-browser clients (e.g. agents) omit Origin
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
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
const STATIC_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
function staticContentType(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return STATIC_TYPES[ext] ?? "application/octet-stream";
}
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const ip = clientIp(req);

  setSecurityHeaders(res);

  // CSRF defence-in-depth: reject cross-origin writes before any side effects.
  if (method !== "GET" && method !== "HEAD" && !sameOriginOk(req)) {
    sendJson(res, 403, { error: "Cross-origin request rejected." });
    return;
  }

  if (path === "/healthz") {
    // Shallow check: process is up.
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  if (path === "/readyz") {
    // Deep check: the database must be reachable for the server to be useful.
    try {
      await Promise.race([
        query("SELECT 1"),
        new Promise((_r, reject) => setTimeout(() => reject(new Error("db timeout")), 2000)),
      ]);
      res.writeHead(200, { "content-type": "text/plain" }).end("ready");
    } catch {
      res.writeHead(503, { "content-type": "text/plain" }).end("db unavailable");
    }
    return;
  }

  if (path === "/api/leaderboard") {
    if (!rateLimit(`lb:${ip}`, 60)) {
      sendJson(res, 429, { error: "Too many requests." });
      return;
    }
    sendJson(res, 200, arena.leaderboard());
    return;
  }

  // Public: lets the account page show a correct sign-in state rather than a
  // button that bounces to a broken Google error when OAuth isn't configured.
  if (path === "/api/auth/status") {
    sendJson(res, 200, { google: google.isConfigured() });
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
      clearStateCookie(res);
      res.writeHead(400, { "content-type": "text/html" }).end("<p>Sign-in failed (bad state). <a href='/account.html'>Try again</a>.</p>");
      return;
    }
    try {
      const token = await google.exchangeCode(code);
      const profile = await google.fetchProfile(token);
      const user = await users.upsertOAuthUser("google", profile.sub, profile.email, profile.name);
      setSessionCookie(res, user.id);
      clearStateCookie(res);
      res.writeHead(302, { location: "/account.html" }).end();
    } catch (err) {
      console.error("OAuth callback error:", (err as Error).message);
      clearStateCookie(res);
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
    sendJson(res, 200, {
      account: user.displayName,
      email: user.email,
      keys: await users.listKeys(user.id),
      stats: arena.statRow(user.displayName),
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
  // `/api/skill` is an alias so agents can find their onboarding doc by name.
  if (path === "/api/guide" || path === "/api/skill") {
    const guide = resolve("SKILL.md");
    if (!existsSync(guide)) {
      res.writeHead(404).end("guide not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(readFileSync(guide));
    return;
  }

  // The human-facing rules + benchmark FAQ (FAQ.md), for the in-page renderer.
  if (path === "/api/faq") {
    const faq = resolve("FAQ.md");
    if (!existsSync(faq)) {
      res.writeHead(404).end("faq not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(readFileSync(faq));
    return;
  }

  // Static files from public/.
  const file = path === "/" ? "spectator.html" : path.replace(/^\/+/, "");
  const full = resolve(PUBLIC_DIR, file);
  if (full.startsWith(PUBLIC_DIR) && existsSync(full)) {
    res.writeHead(200, { "content-type": staticContentType(file) });
    res.end(readFileSync(full));
    return;
  }
  res.writeHead(404).end("Not found");
});

// Reject oversized frames before they are buffered/parsed (abuse / DoS guard).
const WS_MAX_PAYLOAD = 64 * 1024;
const agentWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
const spectatorWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

let agentCounter = 0;

// One live agent connection per account. We track the current socket per account
// so a new connection can REPLACE an existing one (newest wins): this enforces
// "one bot per account" while letting a restarted agent take over cleanly instead
// of being locked out by its own stale socket.
const agentWsByAccount = new Map<string, WebSocket>();
const accountKeyOf = (identity: Identity): string =>
  identity.userId ? `user:${identity.userId}` : `static:${identity.displayName}`;

httpServer.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ip = clientIp(req);
  if (url.pathname === "/agent") {
    // Throttle handshake attempts per IP before doing any auth work.
    if (!rateLimit(`agentws:${ip}`, AGENT_HANDSHAKES_PER_MIN)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    const identity = await resolveIdentity(bearerToken(req));
    if (!identity) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
          'WWW-Authenticate: Bearer realm="snakebench"\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    // One bot per account: a fresh connection replaces the account's existing one
    // (newest wins). The prior socket is force-closed so it cannot keep playing.
    const accountKey = accountKeyOf(identity);
    const replacing = agentWsByAccount.has(accountKey);
    if (!replacing && agentWsByAccount.size >= MAX_AGENT_CONNECTIONS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const existing = agentWsByAccount.get(accountKey);
    if (existing) {
      try { existing.close(4005, "replaced by a newer connection for this account"); } catch { /* ignore */ }
      try { existing.terminate(); } catch { /* ignore */ }
      agentWsByAccount.delete(accountKey);
    }
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWsByAccount.set(accountKey, ws);
      agentWss.emit("connection", ws, identity.displayName, accountKey);
    });
  } else if (url.pathname === "/spectate") {
    if (spectators.size >= MAX_SPECTATORS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    if ((spectatorsByIp.get(ip) ?? 0) >= SPECTATOR_PER_IP) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    spectatorWss.handleUpgrade(req, socket, head, (ws) => {
      spectatorWss.emit("connection", ws, ip);
    });
  } else {
    socket.destroy();
  }
});

agentWss.on("connection", (ws: WebSocket, displayName: string, accountKey: string) => {
  agentCounter += 1;
  const snakeId = `agent_${displayName}_${agentCounter}`;
  const session = {
    snakeId,
    displayName,
    alive: true,
    pendingMove: null,
    lastView: null,
    lastViewTick: -1,
    lastSentAt: 0,
    send: (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      // A new decision window resets the idle clock — the agent may spend the
      // full tick ceiling thinking before it submits.
      if ((msg as { type?: string }).type === "state") resetIdle();
    },
  };

  // Idle-timeout: only drop an agent that goes silent while it has a live snake
  // in an ongoing round. Agents waiting between rounds (queued mid-round, or
  // defeated and awaiting the next round) are kept connected so they are
  // automatically entered into the next round.
  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (arena.isAgentLiveInRound(snakeId)) {
        ws.close(4002, "idle timeout");
      } else {
        resetIdle(); // between rounds: re-arm rather than disconnect
      }
    }, AGENT_IDLE_MS);
  };
  resetIdle();

  session.send({
    type: "welcome",
    you_id: snakeId,
    config,
    docs: { skill: "/api/skill", guide: "/api/guide", human: "/guide.html" },
  });
  arena.addAgent(session);
  console.log(`Agent connected: ${snakeId}`);

  let msgCount = 0;
  let msgWindowReset = Date.now() + 60_000;
  ws.on("message", (raw) => {
    const now = Date.now();
    if (now > msgWindowReset) {
      msgCount = 0;
      msgWindowReset = now + 60_000;
    }
    msgCount += 1;
    if (msgCount > AGENT_MSGS_PER_MIN) {
      ws.close(4429, "message rate limit exceeded");
      return;
    }

    let msg: {
      type?: string;
      tick?: number;
      move?: string;
      log?: unknown;
      note?: unknown;
      intent?: unknown;
      target?: unknown;
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "action" && typeof msg.tick === "number" && typeof msg.move === "string") {
      resetIdle();
      const note = typeof msg.note === "string" ? msg.note : null;
      arena.submitAction(
        snakeId,
        msg.tick,
        msg.move,
        msg.log ?? null,
        note,
        msg.intent ?? null,
        msg.target ?? null,
      );
    }
  });

  ws.on("close", () => {
    clearTimeout(idleTimer);
    arena.removeAgent(snakeId);
    // Only clear the account slot if it still points at THIS socket (a newer
    // connection may have already replaced us).
    if (agentWsByAccount.get(accountKey) === ws) agentWsByAccount.delete(accountKey);
    console.log(`Agent disconnected: ${snakeId}`);
  });
});

spectatorWss.on("connection", (ws: WebSocket, ip: string) => {
  spectators.add(ws);
  spectatorsByIp.set(ip, (spectatorsByIp.get(ip) ?? 0) + 1);
  const init = arena.currentFrame();
  if (init) ws.send(JSON.stringify({ type: "init", ...init }));
  ws.send(JSON.stringify({ type: "leaderboard", board: arena.leaderboard() }));
  ws.on("close", () => {
    spectators.delete(ws);
    const n = (spectatorsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) spectatorsByIp.delete(ip);
    else spectatorsByIp.set(ip, n);
  });
});

/** Fail fast in production when the session secret is missing or weak; the
 * HMAC that protects sessions and OAuth state is only as strong as this key. */
function checkSessionSecret(): void {
  const secret = process.env.SESSION_SECRET || "";
  const isProd = process.env.NODE_ENV === "production";
  if (secret.length >= 32) return;
  const msg =
    secret.length === 0
      ? "SESSION_SECRET is not set."
      : `SESSION_SECRET is too short (${secret.length} chars; need at least 32).`;
  if (isProd) {
    console.error(`FATAL: ${msg} Refusing to start in production.`);
    process.exit(1);
  }
  console.warn(`WARNING: ${msg} Generate one with: openssl rand -hex 32`);
}

/** Refuse unsafe production configuration before accepting traffic. */
function checkProductionGuardrails(): void {
  checkSessionSecret();
  if (process.env.NODE_ENV === "production" && ALLOW_STATIC_KEYS) {
    console.error("FATAL: ALLOW_STATIC_KEYS=1 is forbidden in production. Refusing to start.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkProductionGuardrails();
  await migrate();
  await stats.init();
  httpServer.listen(serverConfig.port, () => {
    arena.start();
    console.log(`\nArena running on http://localhost:${serverConfig.port}`);
    console.log(`  Spectator view:  http://localhost:${serverConfig.port}/`);
    console.log(`  Account:         http://localhost:${serverConfig.port}/account.html`);
    console.log(`  Agent WS:        ws://localhost:${serverConfig.port}/agent  (Authorization: Bearer YOUR_KEY)`);
    console.log(`  Google sign-in:  ${google.isConfigured() ? "configured" : "NOT configured"}`);
    console.log(`  Trust proxy XFF: ${TRUST_PROXY ? "yes" : "no"}`);
    console.log(`  Tick deadline:   ${config.tickDeadlineMs} ms`);
    console.log(`  Agent limits:    ${MAX_AGENT_CONNECTIONS} connections, ${AGENT_MSGS_PER_MIN} msgs/min/conn\n`);
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

// In production, exit on unexpected errors so the PaaS restarts a clean process.
// In dev, log and keep serving so local debugging is not interrupted.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  if (process.env.NODE_ENV === "production") void shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  if (process.env.NODE_ENV === "production") void shutdown("unhandledRejection");
});

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
