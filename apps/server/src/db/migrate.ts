import type { Database } from 'bun:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { SCHEMA } from './schema.js';

export function runMigrations(db: Database): void {
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(SCHEMA);

    // ── Migrations for existing databases ────────────────────────────────
    // Add version column to instances table if missing
    const cols = db.query(`PRAGMA table_info(instances)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'version')) {
      db.exec(`ALTER TABLE instances ADD COLUMN version TEXT`);
    }

    // Add user_id column to instances table if missing (user isolation)
    if (!cols.some(c => c.name === 'user_id')) {
      db.exec(`ALTER TABLE instances ADD COLUMN user_id TEXT REFERENCES users(id)`);
      // Backfill: assign all existing instances to the first user
      const firstUser = db.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get() as { id: string } | null;
      if (firstUser) {
        db.query(`UPDATE instances SET user_id = ? WHERE user_id IS NULL`).run(firstUser.id);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id)`);

    // SECURITY (A-02): Migrate hook_tokens to hash-only storage.
    // The old schema had a plaintext `token` column — remove it and add `token_prefix`
    // for UI display. Existing rows are migrated: prefix derived from token_hash (not
    // from the plaintext token, which we no longer trust to keep). Users will need to
    // regenerate their token once to get a fresh copy; the prefix lets them recognise
    // which token is set.
    const hookTokenCols = db.query(`PRAGMA table_info(hook_tokens)`).all() as Array<{ name: string }>;
    if (hookTokenCols.length > 0) {
      // Add token_prefix if missing
      if (!hookTokenCols.some(c => c.name === 'token_prefix')) {
        db.exec(`ALTER TABLE hook_tokens ADD COLUMN token_prefix TEXT NOT NULL DEFAULT ''`);
        // Backfill prefix from first 8 chars of token_hash (safe — hash is public metadata)
        db.exec(`UPDATE hook_tokens SET token_prefix = substr(token_hash, 1, 8) WHERE token_prefix = ''`);
      }
      // Drop plaintext token column if it still exists (SQLite requires recreate-table approach)
      if (hookTokenCols.some(c => c.name === 'token')) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hook_tokens_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            token_hash TEXT NOT NULL UNIQUE,
            token_prefix TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
        db.exec(`
          INSERT OR IGNORE INTO hook_tokens_new (id, user_id, token_hash, token_prefix, created_at)
          SELECT id, user_id, token_hash,
                 COALESCE(NULLIF(token_prefix, ''), substr(token_hash, 1, 8)),
                 created_at
          FROM hook_tokens
        `);
        db.exec(`DROP TABLE hook_tokens`);
        db.exec(`ALTER TABLE hook_tokens_new RENAME TO hook_tokens`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_hook_tokens_user ON hook_tokens(user_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_hook_tokens_hash ON hook_tokens(token_hash)`);
        // eslint-disable-next-line no-console
        console.log('[migration] Removed plaintext token column from hook_tokens (A-02)');
      }
    }

    // Backfill: generate per-user hook tokens for existing users who don't have one
    const usersWithoutToken = db.query(`
      SELECT u.id FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM hook_tokens ht WHERE ht.user_id = u.id)
    `).all() as Array<{ id: string }>;
    for (const user of usersWithoutToken) {
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const tokenPrefix = rawToken.slice(0, 8);
      db.query(`INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`).run(
        randomUUID(), user.id, tokenHash, tokenPrefix,
      );
      // eslint-disable-next-line no-console
      console.log(`[migration] Generated hook token for user ${user.id}: ${tokenPrefix}…`);
    }

    // Add is_command, command_name, and user_id columns to pending_prompts if missing
    const promptCols = db.query(`PRAGMA table_info(pending_prompts)`).all() as Array<{ name: string }>;
    if (!promptCols.some(c => c.name === 'is_command')) {
      db.exec(`ALTER TABLE pending_prompts ADD COLUMN is_command INTEGER DEFAULT 0`);
    }
    if (!promptCols.some(c => c.name === 'command_name')) {
      db.exec(`ALTER TABLE pending_prompts ADD COLUMN command_name TEXT`);
    }
    if (!promptCols.some(c => c.name === 'user_id')) {
      db.exec(`ALTER TABLE pending_prompts ADD COLUMN user_id TEXT`);
      // Backfill existing rows: look up user_id via session_id → hook_events → instance → user
      db.exec(`
        UPDATE pending_prompts
        SET user_id = (
          SELECT i.user_id
          FROM hook_events h
          JOIN instances i ON i.id = h.instance_id
          WHERE h.session_id = pending_prompts.session_id
            AND i.user_id IS NOT NULL
          LIMIT 1
        )
        WHERE user_id IS NULL
      `);
    }
    // Always ensure index exists (handles partial upgrades and new installs via SCHEMA)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_prompts_user ON pending_prompts(user_id)`);

    // ── Drop FK constraint from metrics_counters.instance_id ─────────────
    // Previously instance_id had REFERENCES instances(id) (and NOT NULL).
    // We drop the FK so counter rows can survive instance deletion by being
    // rolled up under a '__deleted__' sentinel instance_id, preserving
    // user-level totals. The user_id FK remains for user isolation.
    // Detection: if foreign_key_list reports a FK on metrics_counters, recreate.
    const mcFks = db.query(`PRAGMA foreign_key_list(metrics_counters)`).all() as Array<{ table: string; from: string }>;
    const hasMcInstanceFk = mcFks.some(fk => fk.from === 'instance_id' && fk.table === 'instances');
    if (hasMcInstanceFk) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_counters_new (
          user_id     TEXT NOT NULL REFERENCES users(id),
          instance_id TEXT NOT NULL,
          hour_bucket TEXT NOT NULL,
          metric      TEXT NOT NULL CHECK(metric IN ('sessions', 'messages', 'tool_calls', 'tokens', 'cost')),
          value       REAL NOT NULL DEFAULT 0,
          UNIQUE(user_id, instance_id, hour_bucket, metric)
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO metrics_counters_new (user_id, instance_id, hour_bucket, metric, value)
        SELECT user_id, instance_id, hour_bucket, metric, value
        FROM metrics_counters
      `);
      db.exec(`DROP TABLE metrics_counters`);
      db.exec(`ALTER TABLE metrics_counters_new RENAME TO metrics_counters`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_counters_user_hour ON metrics_counters(user_id, hour_bucket)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_counters_instance ON metrics_counters(instance_id, hour_bucket)`);
      // eslint-disable-next-line no-console
      console.log('[migration] Dropped FK on metrics_counters.instance_id (user totals now survive instance delete)');
    }

    // ── Backfill metrics_counters from hook_events ────────────────────────
    // Runs on every startup to catch events that arrived since the last
    // counter row was written (e.g. after a server restart before the new
    // inline-write aggregator was deployed).
    //
    // Finds the cutoff: latest received_at already accounted for in counters
    // (approximated as the end of the latest hour_bucket). Events after that
    // are backfilled. Safe to re-run — uses ON CONFLICT DO UPDATE.

    const eventCount = (db.query(`SELECT COUNT(*) as cnt FROM hook_events`).get() as { cnt: number }).cnt;

    if (eventCount > 0) {
      // Find the latest hour_bucket already in counters. Events received at or
      // after that bucket's start need backfill — the dedup table prevents
      // double-counting anything already accounted for.
      const latestBucket = (db.query(`SELECT MAX(hour_bucket) as ts FROM metrics_counters`).get() as { ts: string | null }).ts;

      // Cutoff: start of the latest bucket. Using bucket start (not +1h) means
      // we re-examine the entire last hour. The metrics_dedup table handles
      // deduplication so nothing gets double-counted.
      // If no counters exist yet, backfill everything (cutoff = epoch).
      let cutoff = '1970-01-01 00:00:00';
      if (latestBucket) {
        // hour_bucket is ISO like '2026-02-24T14:00:00.000Z'
        // Convert to SQLite datetime format for comparison with received_at
        cutoff = new Date(latestBucket).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      }

      const pendingCount = (db.query(`SELECT COUNT(*) as cnt FROM hook_events WHERE received_at > ?`).get(cutoff) as { cnt: number }).cnt;

      if (pendingCount === 0) {
        // Nothing to backfill
      } else {
        // eslint-disable-next-line no-console
        console.log(`[migration] Backfilling ${pendingCount} hook_events after ${cutoff}...`);

        // Helper: received_at is stored as 'YYYY-MM-DD HH:MM:SS' (SQLite datetime, UTC).
        // Convert to ISO hour bucket: 'YYYY-MM-DDTHH:00:00.000Z'
        const toHourBucket = (receivedAt: string): string => {
          const d = new Date(receivedAt.replace(' ', 'T') + 'Z');
          d.setMinutes(0, 0, 0);
          return d.toISOString();
        };

        // Accumulate deltas in memory, then bulk upsert
        const counters = new Map<string, { userId: string; instanceId: string; hourBucket: string; metric: string; value: number }>();

        function addCounter(userId: string, instanceId: string, hourBucket: string, metric: string, value: number): void {
          const key = `${userId}|${instanceId}|${hourBucket}|${metric}`;
          const existing = counters.get(key);
          if (existing) {
            existing.value += value;
          } else {
            counters.set(key, { userId, instanceId, hourBucket, metric, value });
          }
        }

        // 1. Sessions — session.created / SessionStart
        const sessionRows = db.query(`
          SELECT DISTINCT he.session_id, i.user_id, he.instance_id, he.received_at
          FROM hook_events he
          JOIN instances i ON i.id = he.instance_id
          WHERE he.event_type IN ('session.created', 'SessionStart')
            AND i.user_id IS NOT NULL AND i.user_id != ''
            AND he.received_at > ?
        `).all(cutoff) as Array<{ session_id: string; user_id: string; instance_id: string; received_at: string }>;

        // Dedup against already-counted sessions
        const seenSessions = new Set<string>();
        for (const row of sessionRows) {
          const dedupKey = `session|${row.user_id}|${toHourBucket(row.received_at)}|${row.session_id}`;
          if (seenSessions.has(dedupKey)) continue;
          // Check if already in dedup table
          const exists = db.query(`SELECT 1 FROM metrics_dedup WHERE dedup_key = ?`).get(dedupKey);
          if (exists) continue;
          seenSessions.add(dedupKey);
          addCounter(row.user_id, row.instance_id, toHourBucket(row.received_at), 'sessions', 1);
        }
        // eslint-disable-next-line no-console
        console.log(`[migration]   Sessions: ${seenSessions.size} new`);

        // 2. Messages — message.updated (distinct msg IDs not yet in dedup)
        const msgRows = db.query(`
          SELECT
            COALESCE(json_extract(he.payload, '$.info.id'), json_extract(he.payload, '$.id'), he.id) as msg_id,
            i.user_id, he.instance_id,
            MIN(he.received_at) as first_received
          FROM hook_events he
          JOIN instances i ON i.id = he.instance_id
          WHERE he.event_type = 'message.updated'
            AND i.user_id IS NOT NULL AND i.user_id != ''
            AND he.received_at > ?
          GROUP BY msg_id, i.user_id, he.instance_id
        `).all(cutoff) as Array<{ msg_id: string; user_id: string; instance_id: string; first_received: string }>;

        let newMsgs = 0;
        for (const row of msgRows) {
          const dedupKey = `msg|${row.msg_id}`;
          const exists = db.query(`SELECT 1 FROM metrics_dedup WHERE dedup_key = ?`).get(dedupKey);
          if (exists) continue;
          newMsgs++;
          addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'messages', 1);
        }
        // eslint-disable-next-line no-console
        console.log(`[migration]   Messages: ${newMsgs} new`);

        // 3. Tool calls — message.part.updated (callID) + PostToolUse/PreToolUse/tool.execute.after
        const toolOpenCode = db.query(`
          SELECT
            COALESCE(json_extract(he.payload, '$.part.callID'), he.id) as call_id,
            i.user_id, he.instance_id,
            MIN(he.received_at) as first_received
          FROM hook_events he
          JOIN instances i ON i.id = he.instance_id
          WHERE he.event_type = 'message.part.updated'
            AND json_extract(he.payload, '$.part.type') = 'tool'
            AND i.user_id IS NOT NULL AND i.user_id != ''
            AND he.received_at > ?
          GROUP BY call_id, i.user_id, he.instance_id
        `).all(cutoff) as Array<{ call_id: string; user_id: string; instance_id: string; first_received: string }>;

        let newTools = 0;
        for (const row of toolOpenCode) {
          const dedupKey = `tool|${row.call_id}`;
          const exists = db.query(`SELECT 1 FROM metrics_dedup WHERE dedup_key = ?`).get(dedupKey);
          if (exists) continue;
          newTools++;
          addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'tool_calls', 1);
        }

        const toolClaude = db.query(`
          SELECT he.id, i.user_id, he.instance_id, he.received_at
          FROM hook_events he
          JOIN instances i ON i.id = he.instance_id
          WHERE he.event_type IN ('PostToolUse', 'PreToolUse', 'tool.execute.after')
            AND i.user_id IS NOT NULL AND i.user_id != ''
            AND he.received_at > ?
        `).all(cutoff) as Array<{ id: string; user_id: string; instance_id: string; received_at: string }>;

        for (const row of toolClaude) {
          const dedupKey = `tool|${row.id}`;
          const exists = db.query(`SELECT 1 FROM metrics_dedup WHERE dedup_key = ?`).get(dedupKey);
          if (exists) continue;
          newTools++;
          addCounter(row.user_id, row.instance_id, toHourBucket(row.received_at), 'tool_calls', 1);
        }
        // eslint-disable-next-line no-console
        console.log(`[migration]   Tool calls: ${newTools} new`);

        // 4. Tokens & cost — MAX per assistant message (final cumulative value)
        const tokenRows = db.query(`
          SELECT
            COALESCE(json_extract(he.payload, '$.info.id'), json_extract(he.payload, '$.id'), he.id) as msg_id,
            i.user_id, he.instance_id,
            MIN(he.received_at) as first_received,
            MAX(
              COALESCE(json_extract(he.payload, '$.info.tokens.input'), 0) +
              COALESCE(json_extract(he.payload, '$.info.tokens.output'), 0) +
              COALESCE(json_extract(he.payload, '$.info.tokens.reasoning'), 0)
            ) as total_tokens,
            MAX(COALESCE(json_extract(he.payload, '$.info.cost'), 0)) as total_cost
          FROM hook_events he
          JOIN instances i ON i.id = he.instance_id
          WHERE he.event_type = 'message.updated'
            AND json_extract(he.payload, '$.info.role') = 'assistant'
            AND i.user_id IS NOT NULL AND i.user_id != ''
            AND he.received_at > ?
          GROUP BY msg_id, i.user_id, he.instance_id
        `).all(cutoff) as Array<{ msg_id: string; user_id: string; instance_id: string; first_received: string; total_tokens: number; total_cost: number }>;

        let newTokenMsgs = 0;
        for (const row of tokenRows) {
          const dedupKey = `tokens|${row.msg_id}`;
          const existing = db.query(`SELECT meta FROM metrics_dedup WHERE dedup_key = ?`).get(dedupKey) as { meta: string } | undefined;
          if (existing) {
            // Already tracked — add any delta (the backfill may have more recent final values)
            const { t: prevTokens, c: prevCost } = JSON.parse(existing.meta) as { t: number; c: number };
            const tokenDelta = row.total_tokens - prevTokens;
            const costDelta = row.total_cost - prevCost;
            if (tokenDelta > 0) addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'tokens', tokenDelta);
            if (costDelta > 0) addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'cost', costDelta);
            db.query(`UPDATE metrics_dedup SET meta = ? WHERE dedup_key = ?`)
              .run(JSON.stringify({ t: row.total_tokens, c: row.total_cost }), dedupKey);
          } else {
            newTokenMsgs++;
            if (row.total_tokens > 0) addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'tokens', row.total_tokens);
            if (row.total_cost > 0) addCounter(row.user_id, row.instance_id, toHourBucket(row.first_received), 'cost', row.total_cost);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`[migration]   Tokens/cost: ${newTokenMsgs} new assistant messages`);

        // Bulk upsert all counters
        const insertStmt = db.prepare(`
          INSERT INTO metrics_counters (user_id, instance_id, hour_bucket, metric, value)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, instance_id, hour_bucket, metric)
          DO UPDATE SET value = value + excluded.value
        `);

        const tx = db.transaction(() => {
          for (const entry of counters.values()) {
            insertStmt.run(entry.userId, entry.instanceId, entry.hourBucket, entry.metric, entry.value);
          }
        });
        tx();

        // eslint-disable-next-line no-console
        console.log(`[migration] Backfill complete: ${counters.size} counter rows upserted`);
      }
    }

    // ── Prune old metrics_dedup entries (older than 30 days) ──────────────
    // Matches the hook_events retention window in cleanup.ts. Keeping 30 days
    // ensures dedup works correctly even if an instance is offline for weeks.
    db.exec(`DELETE FROM metrics_dedup WHERE hour_bucket < datetime('now', '-30 days')`);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
