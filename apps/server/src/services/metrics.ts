import type { Database } from 'bun:sqlite';
import type { MetricsSummary, MetricsTimeSeries } from '@conduit/shared';

const PERIOD_SECONDS: Record<string, number> = {
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
};

const PERIOD_BUCKETS: Record<string, number> = {
  '1h': 12,   // 5-min buckets
  '24h': 24,  // 1-hour buckets
  '7d': 7,    // 1-day buckets
  '30d': 30,  // 1-day buckets
};

// ── Shared SQL fragment to exclude subagent sessions ──────────────────────
// Must match the logic in sessions.ts to keep counts consistent.
const SUBAGENT_EXCLUSION = `
  AND session_id NOT IN (
    SELECT se.session_id FROM hook_events se
    WHERE se.event_type IN ('session.created', 'session.updated')
      AND se.session_id IS NOT NULL
      AND (json_extract(se.payload, '$.info.parentID') IS NOT NULL
        OR json_extract(se.payload, '$.parentID') IS NOT NULL)
    UNION
    SELECT se.session_id FROM hook_events se
    WHERE se.event_type = 'SessionStart'
      AND se.session_id IS NOT NULL
      AND json_extract(se.payload, '$.parent_session_id') IS NOT NULL
  )`;

// ── Shared fragment for instance filtering ────────────────────────────────
function instanceFilter(instanceId: string | undefined): { sql: string; params: string[] } {
  return instanceId
    ? { sql: 'AND instance_id = ?', params: [instanceId] }
    : { sql: '', params: [] };
}

// ── Shared fragment for user instance scoping ─────────────────────────────
function userInstanceFilter(userId: string | undefined): { sql: string; params: string[] } {
  return userId
    ? { sql: 'AND instance_id IN (SELECT id FROM instances WHERE user_id = ?)', params: [userId] }
    : { sql: '', params: [] };
}

// ── Counters-based user filter ────────────────────────────────────────────
function counterUserFilter(userId: string | undefined): { sql: string; params: string[] } {
  return userId
    ? { sql: 'AND user_id = ?', params: [userId] }
    : { sql: '', params: [] };
}

// ── Counters-based instance filter ────────────────────────────────────────
function counterInstanceFilter(instanceId: string | undefined): { sql: string; params: string[] } {
  return instanceId
    ? { sql: 'AND instance_id = ?', params: [instanceId] }
    : { sql: '', params: [] };
}

// ── Helper: format period start as ISO string ────────────────────────────
function periodStartIso(periodSeconds: number): string {
  return new Date(Date.now() - periodSeconds * 1000).toISOString();
}

// ── Helper: build optional period filter for counters ────────────────────
function counterPeriodFilter(periodStart: string | null): { sql: string; params: string[] } {
  return periodStart
    ? { sql: 'AND hour_bucket >= ?', params: [periodStart] }
    : { sql: '', params: [] };
}

export async function getSummary(
  db: Database,
  instanceId?: string,
  period?: string,
  userId?: string,
): Promise<MetricsSummary> {
  const now = new Date();
  const nowIso = now.toISOString();

  const periodSeconds = period ? PERIOD_SECONDS[period] : undefined;
  const periodStart = periodSeconds ? periodStartIso(periodSeconds) : null;

  // Counters-based filters
  const cu = counterUserFilter(userId);
  const ci = counterInstanceFilter(instanceId);
  const cp = counterPeriodFilter(periodStart);

  // ── Read pre-aggregated counters ──────────────────────────────────────
  type CounterRow = { metric: string; total: number };
  const counterRows = db.query(`
    SELECT metric, SUM(value) as total
    FROM metrics_counters
    WHERE 1=1
      ${cu.sql}
      ${ci.sql}
      ${cp.sql}
    GROUP BY metric
  `).all(...cu.params, ...ci.params, ...cp.params) as CounterRow[];

  const counters: Record<string, number> = {};
  for (const row of counterRows) {
    counters[row.metric] = row.total;
  }

  // ── Total sessions (live count from hook_events — same logic as sessions page) ──
  const uif = userInstanceFilter(userId);
  const inf = instanceFilter(instanceId);
  // (also used for active sessions query below — declare here to avoid duplicate)

  // Period filter for sessions: use first_seen (MIN received_at per session)
  const sessionPeriodFilter = periodStart
    ? `AND h.session_id IN (
         SELECT session_id FROM hook_events
         WHERE session_id IS NOT NULL
           AND session_id NOT IN ('conduit-config', 'conduit-models', 'unknown')
         GROUP BY session_id
         HAVING MIN(received_at) >= '${periodStart}'
       )`
    : '';

  const totalSessionsRow = db.query(`
    SELECT COUNT(DISTINCT h.session_id) as total
    FROM hook_events h
    WHERE h.session_id IS NOT NULL
      AND h.session_id NOT IN ('conduit-config', 'conduit-models', 'unknown')
      ${uif.sql}
      ${inf.sql}
      ${SUBAGENT_EXCLUSION}
      ${sessionPeriodFilter}
  `).get(...uif.params, ...inf.params) as { total: number } | null;

  const totalSessions = totalSessionsRow?.total ?? 0;

  // ── Active sessions (live query — cannot be pre-aggregated) ───────────
  const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;
  const activeThreshold = new Date(Date.now() - ACTIVE_THRESHOLD_MS).toISOString().replace('T', ' ').replace('Z', '');

  const activeRow = db.query(`
    WITH session_latest AS (
      SELECT session_id, MAX(received_at) as last_activity
      FROM hook_events
      WHERE session_id IS NOT NULL
        AND session_id NOT IN ('unknown', 'conduit-config', 'conduit-models')
        ${SUBAGENT_EXCLUSION}
        ${inf.sql}
        ${uif.sql}
      GROUP BY session_id
      HAVING MAX(received_at) >= ?
    ),
    session_status AS (
      SELECT sl.session_id,
        sl.last_activity,
        COALESCE(
          (SELECT s.event_type FROM hook_events s
           WHERE s.session_id = sl.session_id
             AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacted')
           ORDER BY s.received_at DESC LIMIT 1),
          'none'
        ) as last_status,
        (SELECT s.received_at FROM hook_events s
         WHERE s.session_id = sl.session_id
           AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacted')
         ORDER BY s.received_at DESC LIMIT 1
        ) as status_at
      FROM session_latest sl
    )
    SELECT COUNT(*) as cnt FROM session_status
    WHERE last_status NOT IN ('Stop', 'session.error', 'session.compacted')
      AND (last_status = 'none' OR (last_status = 'session.idle' AND last_activity > status_at))
  `).get(...inf.params, ...uif.params, activeThreshold) as { cnt: number } | null;

  const activeSessions = activeRow?.cnt ?? 0;

  // ── Period bounds ─────────────────────────────────────────────────────
  const earliest = periodStart
    ? null
    : db.query(`
        SELECT MIN(hour_bucket) as ts FROM metrics_counters WHERE 1=1 ${cu.sql} ${ci.sql}
      `).get(...cu.params, ...ci.params) as { ts: string | null } | null;

  return {
    totalSessions,
    activeSessions,
    totalMessages: counters['messages'] ?? 0,
    totalToolCalls: counters['tool_calls'] ?? 0,
    avgSessionDuration: 0,
    totalTokens: Math.round(counters['tokens'] ?? 0),
    totalCost: Math.round((counters['cost'] ?? 0) * 10000) / 10000,
    periodStart: periodStart ?? (earliest?.ts ?? nowIso),
    periodEnd: nowIso,
  };
}

export function getTimeSeries(
  db: Database,
  metric: string,
  period: string,
  instanceId?: string,
  userId?: string,
): MetricsTimeSeries {
  const periodSeconds = PERIOD_SECONDS[period];
  if (!periodSeconds) {
    return { timestamps: [], values: [], label: metric, unit: 'count' };
  }

  const buckets = PERIOD_BUCKETS[period] ?? 24;
  const bucketSeconds = periodSeconds / buckets;

  let label: string;
  let unit = 'count';
  let counterMetric: string | null;
  switch (metric) {
    case 'sessions': label = 'Sessions'; counterMetric = null; break; // derived from hook_events
    case 'tools':    label = 'Tool Calls'; counterMetric = 'tool_calls'; break;
    case 'messages': label = 'Messages'; counterMetric = 'messages'; break;
    case 'tokens':   label = 'Tokens'; counterMetric = 'tokens'; break;
    case 'cost':     label = 'Cost'; unit = 'usd'; counterMetric = 'cost'; break;
    default: return { timestamps: [], values: [], label: metric, unit: 'count' };
  }

  const now = Date.now();
  const periodStartMs = now - periodSeconds * 1000;
  const startIso = new Date(periodStartMs).toISOString();

  const cu = counterUserFilter(userId);
  const ci = counterInstanceFilter(instanceId);
  const uif = userInstanceFilter(userId);
  const inf = instanceFilter(instanceId);

  // Initialize output arrays
  const timestamps: string[] = [];
  const values: number[] = new Array(buckets).fill(0) as number[];
  for (let i = 0; i < buckets; i++) {
    timestamps.push(new Date(periodStartMs + i * bucketSeconds * 1000).toISOString());
  }

  type BucketRow = { bucket: number; total: number };

  if (counterMetric === null) {
    // ── Sessions: derive from hook_events (first_seen per session bucketed) ──
    const rows = db.query(`
      SELECT CAST((julianday(first_seen) - julianday(?)) * 86400 / ? AS INTEGER) as bucket,
        COUNT(*) as total
      FROM (
        SELECT h.session_id, MIN(h.received_at) as first_seen
        FROM hook_events h
        WHERE h.session_id IS NOT NULL
          AND h.session_id != 'conduit-config'
          AND h.session_id != 'unknown'
          AND h.received_at >= ?
          ${uif.sql}
          ${inf.sql}
          ${SUBAGENT_EXCLUSION}
        GROUP BY h.session_id
      ) AS sessions
      GROUP BY bucket
      HAVING bucket >= 0 AND bucket < ?
    `).all(startIso, bucketSeconds, startIso, ...uif.params, ...inf.params, buckets) as BucketRow[];

    for (const row of rows) {
      values[row.bucket] = row.total;
    }
  } else {
    // ── Counters table with bucketing ────────────────────────────────────
    const rows = db.query(`
      SELECT CAST((julianday(hour_bucket) - julianday(?)) * 86400 / ? AS INTEGER) as bucket,
        SUM(value) as total
      FROM metrics_counters
      WHERE metric = ?
        AND hour_bucket >= ?
        ${cu.sql}
        ${ci.sql}
      GROUP BY bucket
      HAVING bucket >= 0 AND bucket < ?
    `).all(startIso, bucketSeconds, counterMetric, startIso, ...cu.params, ...ci.params, buckets) as BucketRow[];

    for (const row of rows) {
      if (metric === 'cost') {
        values[row.bucket] = Math.round(row.total * 10000) / 10000;
      } else if (metric === 'tokens') {
        values[row.bucket] = Math.round(row.total);
      } else {
        values[row.bucket] = row.total;
      }
    }
  }

  return { timestamps, values, label, unit };
}
