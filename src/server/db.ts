import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

/**
 * Single shared Postgres connection pool. Real persistence — no in-memory
 * substitutes. The connection string comes from DATABASE_URL.
 */
let poolRef: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (poolRef) return poolRef;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Point it at your Postgres instance.");
  }
  // Managed Postgres (Render, Supabase, Neon) requires TLS; allow self-signed.
  const ssl = /sslmode=require/.test(connectionString) || process.env.PGSSL === "1"
    ? { rejectUnauthorized: false }
    : undefined;
  poolRef = new pg.Pool({ connectionString, ssl, max: Number(process.env.PG_POOL_MAX) || 10 });
  poolRef.on("error", (err) => console.error("Postgres pool error:", err.message));
  return poolRef;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** Apply the schema. Idempotent (CREATE TABLE IF NOT EXISTS). */
export async function migrate(): Promise<void> {
  const sql = readFileSync(resolve("src/server/schema.sql"), "utf8");
  await getPool().query(sql);
}

export async function closePool(): Promise<void> {
  if (poolRef) {
    await poolRef.end();
    poolRef = null;
  }
}
