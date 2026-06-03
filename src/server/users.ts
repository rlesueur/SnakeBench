import { createHash, randomBytes } from "node:crypto";
import { query } from "./db.js";

export interface User {
  id: string;
  displayName: string;
  email: string | null;
}

export interface KeyInfo {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Identity {
  userId: string;
  displayName: string;
}

const KEYS_PER_USER = Number(process.env.API_KEYS_PER_USER) || 5;
const NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9 _.-]{1,30}$/;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Cached display_name -> user id resolver (display names are unique). */
const idCache = new Map<string, string | null>();
export async function userIdByDisplayName(name: string): Promise<string | null> {
  if (idCache.has(name)) return idCache.get(name)!;
  const r = await query<{ id: string }>("SELECT id FROM users WHERE display_name = $1", [name]);
  const id = r.rows[0]?.id ?? null;
  idCache.set(name, id);
  return id;
}
export function clearLookupCache(): void {
  idCache.clear();
}

function sanitiseName(raw: string): string {
  const base = (raw || "player").replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 24);
  return base.length >= 2 ? base : "player";
}

/**
 * Postgres-backed users and API keys. Humans are created via OAuth; agents
 * authenticate with API keys that are hashed at rest (only the hash and a short
 * display prefix are stored).
 */
export class UserStore {
  /** key_hash -> identity cache, so the WS hot path avoids a DB round-trip. */
  private readonly keyCache = new Map<string, Identity>();

  /** Find or create the user behind an OAuth identity. */
  async upsertOAuthUser(
    provider: string,
    subject: string,
    email: string | null,
    name: string,
  ): Promise<User> {
    const existing = await query<{ id: string; display_name: string; email: string | null }>(
      "SELECT id, display_name, email FROM users WHERE provider = $1 AND subject = $2",
      [provider, subject],
    );
    if (existing.rows[0]) {
      const u = existing.rows[0];
      return { id: u.id, displayName: u.display_name, email: u.email };
    }

    // Assign a unique display name, appending a numeric suffix on collision.
    const base = sanitiseName(name || (email ? email.split("@")[0]! : "player"));
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      try {
        const inserted = await query<{ id: string; display_name: string; email: string | null }>(
          `INSERT INTO users (provider, subject, email, display_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, display_name, email`,
          [provider, subject, email, candidate],
        );
        const u = inserted.rows[0]!;
        return { id: u.id, displayName: u.display_name, email: u.email };
      } catch (err) {
        // Unique violation (race or name clash): retry with the next suffix,
        // but re-check the OAuth identity in case it was created concurrently.
        const dup = await query<{ id: string; display_name: string; email: string | null }>(
          "SELECT id, display_name, email FROM users WHERE provider = $1 AND subject = $2",
          [provider, subject],
        );
        if (dup.rows[0]) {
          const u = dup.rows[0];
          return { id: u.id, displayName: u.display_name, email: u.email };
        }
        if (attempt === 49) throw err;
      }
    }
    throw new Error("Could not allocate a unique display name.");
  }

  async getUser(userId: string): Promise<User | null> {
    const r = await query<{ id: string; display_name: string; email: string | null }>(
      "SELECT id, display_name, email FROM users WHERE id = $1",
      [userId],
    );
    const u = r.rows[0];
    return u ? { id: u.id, displayName: u.display_name, email: u.email } : null;
  }

  /** Rename a user (also updates their historical leaderboard rows). */
  async rename(userId: string, displayName: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const name = (displayName || "").trim();
    if (!NAME_RE.test(name)) {
      return { ok: false, error: "Name must be 2-31 chars: letters, numbers, space, _ . - (not starting with space)." };
    }
    const taken = await query("SELECT 1 FROM users WHERE lower(display_name) = lower($1) AND id <> $2", [name, userId]);
    if (taken.rowCount) return { ok: false, error: "That display name is already taken." };
    await query("UPDATE users SET display_name = $1 WHERE id = $2", [name, userId]);
    await query("UPDATE round_results SET display_name = $1 WHERE user_id = $2", [name, userId]);
    await query("UPDATE decision_logs SET display_name = $1 WHERE user_id = $2", [name, userId]);
    this.keyCache.clear();
    clearLookupCache();
    return { ok: true };
  }

  /** Resolve a presented raw key to an identity (cached). Null if unknown/revoked. */
  async findKey(rawKey: string): Promise<Identity | null> {
    if (!rawKey) return null;
    const hash = hashKey(rawKey);
    const cached = this.keyCache.get(hash);
    if (cached) {
      void query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [hash]).catch(() => {});
      return cached;
    }
    const r = await query<{ user_id: string; display_name: string }>(
      `SELECT k.user_id, u.display_name
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hash],
    );
    const row = r.rows[0];
    if (!row) return null;
    const identity: Identity = { userId: row.user_id, displayName: row.display_name };
    this.keyCache.set(hash, identity);
    void query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [hash]).catch(() => {});
    return identity;
  }

  async listKeys(userId: string): Promise<KeyInfo[]> {
    const r = await query<{
      id: string;
      key_prefix: string;
      label: string | null;
      created_at: string;
      last_used_at: string | null;
    }>(
      `SELECT id, key_prefix, label, created_at, last_used_at
       FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    );
    return r.rows.map((k) => ({
      id: k.id,
      prefix: k.key_prefix,
      label: k.label,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
    }));
  }

  /** Mint a new key. Returns the raw key once; only its hash is stored. */
  async createKey(
    userId: string,
    label: string | null,
  ): Promise<{ ok: true; key: string; prefix: string } | { ok: false; error: string }> {
    const active = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    if (Number(active.rows[0]?.n ?? 0) >= KEYS_PER_USER) {
      return { ok: false, error: `Key limit reached (${KEYS_PER_USER}). Revoke one first.` };
    }
    const raw = `sk_${randomBytes(24).toString("hex")}`;
    const prefix = `${raw.slice(0, 11)}...`;
    await query(
      "INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)",
      [userId, hashKey(raw), prefix, (label || "").slice(0, 60) || null],
    );
    return { ok: true, key: raw, prefix };
  }

  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const r = await query(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [keyId, userId],
    );
    // Drop any cached identity for this user's keys (cheap and safe).
    this.keyCache.clear();
    return (r.rowCount ?? 0) > 0;
  }
}
