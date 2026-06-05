import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Stateless signed-cookie sessions. The cookie carries the user id and an
 * expiry, signed with SESSION_SECRET (HMAC-SHA256). No server-side session
 * table is needed.
 */
const SECRET = process.env.SESSION_SECRET || "";
const COOKIE = "gs_session";
const STATE_COOKIE = "gs_oauth_state";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SECURE = process.env.OAUTH_REDIRECT_BASE?.startsWith("https://") ?? false;

if (!SECRET) {
  console.warn("SESSION_SECRET is not set — sessions will be rejected until it is.");
}

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Create a signed session token for a user id. */
function makeToken(userId: string): string {
  const exp = Date.now() + MAX_AGE_MS;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify a token and return the user id, or null. */
function readToken(token: string | undefined): string | null {
  if (!token || !SECRET) return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid: string; exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

export function getSessionUserId(req: IncomingMessage): string | null {
  return readToken(parseCookies(req)[COOKIE]);
}

export function setSessionCookie(res: ServerResponse, userId: string): void {
  const token = makeToken(userId);
  const attrs = [
    `${COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(res: ServerResponse): void {
  const attrs = [`${COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

// --- OAuth CSRF state (short-lived signed cookie) ---------------------------

export function setStateCookie(res: ServerResponse, state: string): void {
  const signed = `${state}.${sign(state)}`;
  const attrs = [`${STATE_COOKIE}=${signed}`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=600"];
  if (SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function verifyStateCookie(req: IncomingMessage, state: string): boolean {
  const raw = parseCookies(req)[STATE_COOKIE];
  if (!raw || !state) return false;
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return false;
  const value = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  return safeEqual(sig, sign(value)) && safeEqual(value, state);
}

/** Expire the OAuth state cookie. Appends to any existing Set-Cookie header so
 * it can be combined with the session cookie set in the same response. */
export function clearStateCookie(res: ServerResponse): void {
  const attrs = [`${STATE_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (SECURE) attrs.push("Secure");
  const value = attrs.join("; ");
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", value);
  else if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, value]);
  else res.setHeader("Set-Cookie", [String(existing), value]);
}
