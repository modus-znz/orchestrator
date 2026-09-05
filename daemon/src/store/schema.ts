/** SQLite is a *projection* of the JSONL logs (spec §4.3): losing it is an
 *  inconvenience, never data loss. Every statement here is idempotent. */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  prompt           TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  model            TEXT NOT NULL,
  budget_usd       REAL NOT NULL,
  timeout_ms       INTEGER NOT NULL,
  permission_mode  TEXT NOT NULL,
  allowed_tools    TEXT,
  depends_on       TEXT NOT NULL DEFAULT '[]',
  steerable        INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,
  session_id       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  cost_usd         REAL NOT NULL DEFAULT 0,
  num_turns        INTEGER NOT NULL DEFAULT 0,
  exit_code        INTEGER,
  error            TEXT,
  cli_version      TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  job_id        TEXT,
  pid           INTEGER,
  name          TEXT,
  cwd           TEXT,
  alive         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  harness       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_alive ON sessions(alive);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  job_id     TEXT,
  ts         TEXT NOT NULL,
  source     TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_job  ON events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS costs (
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  job_id        TEXT,
  ts            TEXT NOT NULL,
  model         TEXT NOT NULL,
  usd           REAL NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_costs_ts    ON costs(ts);
CREATE INDEX IF NOT EXISTS idx_costs_model ON costs(model);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
