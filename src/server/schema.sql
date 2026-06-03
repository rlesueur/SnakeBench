-- Grid Snake benchmark schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  email        TEXT,
  display_name TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS round_results (
  id           BIGSERIAL PRIMARY KEY,
  round        INTEGER NOT NULL,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  peak_size    INTEGER NOT NULL,
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS round_results_name_idx ON round_results (display_name);

CREATE TABLE IF NOT EXISTS decision_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  round        INTEGER NOT NULL,
  tick         INTEGER NOT NULL,
  move         TEXT NOT NULL,
  shed         BOOLEAN NOT NULL DEFAULT false,
  latency_ms   INTEGER,
  view         JSONB,
  evidence     JSONB,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decision_logs_name_ts_idx ON decision_logs (display_name, ts DESC);
