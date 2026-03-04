const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  use_case TEXT CHECK(use_case IN ('personal', 'team', 'agency')),
  onboarding_complete INTEGER DEFAULT 0,
  subscription_status TEXT DEFAULT 'trial',
  trial_started_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  family_id TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  token_hash TEXT PRIMARY KEY,
  revoked_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('opencode', 'claude-code')),
  url TEXT,
  version TEXT,
  user_id TEXT REFERENCES users(id),
  status TEXT DEFAULT 'disconnected',
  hook_token_hash TEXT,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hook_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT REFERENCES instances(id),
  event_type TEXT NOT NULL,
  session_id TEXT,
  payload TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id TEXT PRIMARY KEY,
  instance_id TEXT,
  total_sessions INTEGER,
  active_sessions INTEGER,
  total_messages INTEGER,
  total_tool_calls INTEGER,
  captured_at TEXT DEFAULT (datetime('now'))
);

-- Latest config snapshot sent from the agent to Conduit.
-- One row per instance; upserted whenever a config.sync event arrives.
CREATE TABLE IF NOT EXISTS config_snapshots (
  instance_id TEXT PRIMARY KEY,
  agent_type  TEXT NOT NULL CHECK(agent_type IN ('opencode', 'claude-code')),
  content     TEXT NOT NULL,       -- raw JSON string of the config file
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Pending config update queued by the dashboard, waiting to be pulled by the agent.
-- Cleared (deleted) once the agent acknowledges via POST /config/ack.
CREATE TABLE IF NOT EXISTS config_pending (
  instance_id TEXT PRIMARY KEY,
  content     TEXT NOT NULL,       -- raw JSON string to write to the local config file
  queued_at   TEXT DEFAULT (datetime('now'))
);

-- Pending prompts queued by the dashboard, waiting to be picked up by the plugin.
-- The plugin polls GET /api/prompts/pending and acks via POST /api/prompts/:id/ack.
-- user_id is stored directly so scoping queries never need the fragile hook_events join.
CREATE TABLE IF NOT EXISTS pending_prompts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  user_id     TEXT,
  content     TEXT NOT NULL,
  status      TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'delivered', 'failed')),
  is_command  INTEGER DEFAULT 0,
  command_name TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_link_email ON magic_link_tokens(email);
CREATE INDEX IF NOT EXISTS idx_magic_link_expires ON magic_link_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_hook_events_instance ON hook_events(instance_id);
CREATE INDEX IF NOT EXISTS idx_hook_events_received ON hook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id);
CREATE INDEX IF NOT EXISTS idx_hook_events_event_type ON hook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_hook_events_session_event ON hook_events(session_id, event_type, received_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_event_received ON hook_events(event_type, received_at);

-- SECURITY: hook_tokens stores only the SHA-256 hash of the token, never the plaintext.
-- token_prefix holds the first 8 hex chars for UI display ("conduit_xxxxxxxx...").
-- The plaintext is returned to the user exactly once (at creation/regeneration) and never stored.
CREATE TABLE IF NOT EXISTS hook_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hook_tokens_user ON hook_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_hook_tokens_hash ON hook_tokens(token_hash);

-- Pre-aggregated metrics counters — one row per user+instance+hour+metric.
-- Written inline (no buffer) by MetricsAggregator on every hook event.
-- Eliminates expensive json_extract scans on hook_events at query time.
-- instance_id has no FK constraint so counter rows can be rolled up under a
-- '__deleted__' sentinel when an instance is removed, preserving user-level totals.
CREATE TABLE IF NOT EXISTS metrics_counters (
  user_id     TEXT NOT NULL REFERENCES users(id),
  instance_id TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,  -- ISO hour string e.g. '2026-02-24T14:00:00Z'
  metric      TEXT NOT NULL CHECK(metric IN ('sessions', 'messages', 'tool_calls', 'tokens', 'cost')),
  value       REAL NOT NULL DEFAULT 0,
  UNIQUE(user_id, instance_id, hour_bucket, metric)
);

CREATE INDEX IF NOT EXISTS idx_metrics_counters_user_hour ON metrics_counters(user_id, hour_bucket);
CREATE INDEX IF NOT EXISTS idx_metrics_counters_instance ON metrics_counters(instance_id, hour_bucket);

CREATE INDEX IF NOT EXISTS idx_metrics_captured ON metrics_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_pending_prompts_status ON pending_prompts(status);
CREATE INDEX IF NOT EXISTS idx_revoked_access_expires ON revoked_access_tokens(expires_at);

-- Archived sessions — stores session IDs that should be hidden from the default list.
-- Sessions are derived from hook_events (no dedicated table), so archiving is tracked here.
CREATE TABLE IF NOT EXISTS archived_sessions (
  session_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  archived_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_sessions_user ON archived_sessions(user_id);

-- OAuth state tokens + PKCE verifiers (CSRF protection for the redirect round-trip).
-- state_hash stores SHA-256 hex of the raw state sent to the browser — NEVER the raw value.
-- code_verifier is generated entirely server-side and NEVER sent to the browser.
-- Rows are consumed atomically via DELETE (single-use) and cleaned up by the hourly job.
CREATE TABLE IF NOT EXISTS oauth_states (
  id             TEXT PRIMARY KEY,
  state_hash     TEXT NOT NULL UNIQUE,
  provider       TEXT NOT NULL CHECK(provider IN ('github', 'gitlab')),
  code_verifier  TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- OAuth provider → local user mapping.
-- provider_user_id stores the provider's stable numeric ID as a string.
-- UNIQUE on (provider, provider_user_id) enforces one local account per provider identity.
-- A user may have connections to multiple providers, but each provider identity maps to exactly one user.
CREATE TABLE IF NOT EXISTS oauth_connections (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  provider         TEXT NOT NULL CHECK(provider IN ('github', 'gitlab')),
  provider_user_id TEXT NOT NULL,
  created_at       TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_user ON oauth_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_lookup ON oauth_connections(provider, provider_user_id);

-- Deduplication table for metrics — prevents double-counting sessions, messages,
-- tool calls, and tokens across restarts (replaces the in-memory Sets/Maps).
-- meta column stores JSON for token/cost delta tracking.
CREATE TABLE IF NOT EXISTS metrics_dedup (
  dedup_key  TEXT PRIMARY KEY,
  hour_bucket TEXT NOT NULL,
  meta       TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_dedup_hour ON metrics_dedup(hour_bucket);

-- Device flow sessions for RFC 8628-style terminal activation.
-- Replaces in-memory Maps so sessions survive server restarts.
-- approved is 0 (pending) or 1 (user approved via dashboard).
-- hook_token is written by /install/approve and read (once) by /install/poll.
-- Expired rows are pruned inline at the start of /install/device and /install/approve.
CREATE TABLE IF NOT EXISTS device_flow_sessions (
  device_code  TEXT PRIMARY KEY,
  user_code    TEXT NOT NULL UNIQUE,
  approved     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id),
  hook_token   TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_flow_user_code ON device_flow_sessions(user_code);
CREATE INDEX IF NOT EXISTS idx_device_flow_expires   ON device_flow_sessions(expires_at);

-- Available models reported by each instance on startup.
-- One row per (instance_id, provider_id, model_id) — upserted on every models.sync event.
-- Deleted when the instance is deleted (cascade via application logic, not FK, since
-- instances may be deregistered and re-registered with the same ID).
CREATE TABLE IF NOT EXISTS instance_models (
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  model_name  TEXT NOT NULL,
  synced_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_instance_models_instance ON instance_models(instance_id);
`;

export { SCHEMA };
