/**
 * Canonical OpenCode plugin template — single source of truth.
 *
 * Both the MCP server (`packages/mcp-server`) and the Conduit API server
 * (`apps/server`) call this function to generate the plugin JS that gets
 * written to `~/.config/opencode/plugins/conduit.js`.
 *
 * Features:
 *  - HMAC-signed webhook forwarding for all OpenCode events
 *  - Config sync (push local → Conduit, pull pending → local + hot-apply)
 *  - Prompt injection with 200ms debounce (SSE + session.idle collapse)
 *  - Slash command routing via `client.session.command()`
 *  - SSE real-time prompt stream with exponential backoff reconnect
 *  - Subagent session filtering (parentID sessions excluded)
 *  - Compaction event detection and forwarding
 */
export function generateOpenCodePluginSource(
  token: string,
  apiUrl: string,
): string {
  return `// Conduit OpenCode plugin — auto-generated, do not edit.
// Forwards OpenCode session/message events to the Conduit API.
// Syncs the local config file to/from the Conduit dashboard.
// Injects pending prompts from the dashboard into the active agent session.
const TOKEN = ${JSON.stringify(token)};
const API_URL = ${JSON.stringify(apiUrl)};

async function send(eventType, sessionId, data) {
  try {
    const isoNow = new Date().toISOString();
    const ts = Date.now();
    const payload = JSON.stringify({ event: eventType, timestamp: isoNow, sessionId, data });
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", TOKEN).update(\`\${ts}.\${payload}\`).digest("hex");
    await fetch(\`\${API_URL}/hooks\`, {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${TOKEN}\`,
        "Content-Type": "application/json",
        "X-Conduit-Timestamp": String(ts),
        "X-Conduit-Signature": \`sha256=\${sig}\`,
      },
      body: payload,
    });
  } catch (_) { /* fire-and-forget */ }
}

// ---------------------------------------------------------------------------
// Batched event queue — buffers events for up to 1 second then flushes them
// in a single POST /hooks/batch request. Reduces ~40 req/sec to ~1 req/sec
// during active OpenCode generation (message.part.updated bursts).
//
// Early flush is triggered on session.idle, session.compacted, and session.error
// so that all buffered events reach the server before the dashboard reads session
// state. These trigger events are sent directly via send() AFTER the flush to
// preserve ordering.
// ---------------------------------------------------------------------------

const _queue = [];
let _flushTimer = null;
const FLUSH_DELAY_MS = 1000;
const MAX_BATCH_SIZE = 100;

async function _flushQueue() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_queue.length === 0) return;
  const batch = _queue.splice(0);
  try {
    const { createHmac } = await import("node:crypto");
    const ts = Date.now();
    const body = JSON.stringify({ events: batch });
    const sig = createHmac("sha256", TOKEN).update(\`\${ts}.\${body}\`).digest("hex");
    const res = await fetch(\`\${API_URL}/hooks/batch\`, {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${TOKEN}\`,
        "Content-Type": "application/json",
        "X-Conduit-Timestamp": String(ts),
        "X-Conduit-Signature": \`sha256=\${sig}\`,
      },
      body,
    });
    // Fall back to individual sends if server doesn't support batch endpoint yet
    if (res.status === 404) {
      for (const ev of batch) {
        await send(ev.event, ev.sessionId, ev.data);
      }
    }
  } catch (_) {
    // Best-effort — events are fire-and-forget
  }
}

function enqueue(eventType, sessionId, data) {
  _queue.push({ event: eventType, timestamp: new Date().toISOString(), sessionId, data });
  if (_queue.length >= MAX_BATCH_SIZE) {
    // Pressure valve — flush immediately without waiting for the timer
    _flushQueue();
    return;
  }
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => { _flushTimer = null; _flushQueue(); }, FLUSH_DELAY_MS);
  }
}

function getConfigPath() {
  const { env, platform } = process;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return \`\${xdg}/opencode/opencode.json\`;
  if (platform === "win32") {
    const base = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH)
      ? (env.USERPROFILE || \`\${env.HOMEDRIVE}\${env.HOMEPATH}\`)
      : null;
    return base ? \`\${base}/.config/opencode/opencode.json\` : null;
  }
  return env.HOME ? \`\${env.HOME}/.config/opencode/opencode.json\` : null;
}

async function syncConfigToConduit() {
  try {
    const { readFile } = await import("node:fs/promises");
    const path = getConfigPath();
    if (!path) return;
    let raw;
    try { raw = await readFile(path, "utf8"); } catch { raw = "{}"; }
    try { JSON.parse(raw); } catch { return; }
    await send("config.sync", "conduit-config", { agentType: 'opencode', content: raw });
  } catch (_) { /* best-effort */ }
}

async function syncModelsToConduit(client) {
  try {
    // client.provider.list() returns { all: Provider[], default: {...}, connected: string[] }
    // where Provider = { id: string, name: string, models: Record<string, { id: string, name: string }> }
    const result = await client.provider.list();
    const providers = result?.data;
    if (!providers || !Array.isArray(providers.all) || !Array.isArray(providers.connected)) return;

    const connectedSet = new Set(providers.connected);
    const models = [];

    for (const provider of providers.all) {
      // Only include providers the user has authenticated/configured
      if (!connectedSet.has(provider.id)) continue;
      const providerModels = provider.models;
      if (!providerModels || typeof providerModels !== "object") continue;
      for (const modelEntry of Object.values(providerModels)) {
        if (!modelEntry || typeof modelEntry !== "object") continue;
        const modelId = modelEntry.id;
        const modelName = modelEntry.name ?? modelEntry.id;
        if (typeof modelId !== "string") continue;
        models.push({ providerId: provider.id, modelId, modelName });
      }
    }

    if (models.length === 0) return;
    await send("models.sync", "conduit-models", { agentType: 'opencode', models });
  } catch (_) { /* best-effort */ }
}

async function applyPendingConfig(client) {
  try {
    const resp = await fetch(\`\${API_URL}/config/pending\`, {
      headers: { "Authorization": \`Bearer \${TOKEN}\` },
    });
    if (!resp.ok) return;
    const body = await resp.json();
    const content = body?.data?.content;
    if (!content) return;

    // Parse to validate before writing
    let parsedConfig;
    try { parsedConfig = JSON.parse(content); } catch { return; }

    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = getConfigPath();
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");

    // Hot-apply the config at runtime via OpenCode SDK
    if (client?.config?.update) {
      try {
        await client.config.update({ body: parsedConfig });
      } catch (_) { /* best-effort: file was written, runtime update failed */ }
    }

    await fetch(\`\${API_URL}/config/ack\`, {
      method: "POST",
      headers: { "Authorization": \`Bearer \${TOKEN}\`, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (_) { /* best-effort */ }
}

function extractSessionId(type, props) {
  if (!props) return "unknown";
  switch (type) {
    case "session.created":
    case "session.updated":
      return props.info?.id ?? "unknown";
    case "session.idle":
    case "session.error":
    case "tool.execute.after":
    case "todo.updated":
    case "mcp.tools.changed":
      return props.sessionID ?? "unknown";
    case "message.updated":
      return props.info?.sessionID ?? "unknown";
    case "message.part.updated":
      return props.part?.sessionID ?? "unknown";
    default:
      return props.sessionID ?? props.id ?? "unknown";
  }
}

// ---------------------------------------------------------------------------
// Prompt injection: polls Conduit for pending prompts and injects them
// into the active OpenCode session via client.session.promptAsync().
// ---------------------------------------------------------------------------

let _injecting = false; // guard against concurrent injection
let _injectTimer = null; // debounce timer for injection requests

/**
 * Debounced wrapper around _doInjectPendingPrompts.
 * Collapses rapid-fire calls (SSE prompt.queued + session.idle) into a single execution.
 */
function injectPendingPrompts(client, idleSessionId) {
  if (_injectTimer) clearTimeout(_injectTimer);
  _injectTimer = setTimeout(() => {
    _injectTimer = null;
    _doInjectPendingPrompts(client, idleSessionId);
  }, 200);
}

/**
 * Find the best session to inject a prompt into.
 * Priority: 1) explicit sessionId from the prompt, 2) idle root session, 3) any root session.
 * Subagent sessions (those with parentID) are always excluded.
 */
async function findTargetSession(client, preferredId) {
  // If the dashboard specified a session, use it directly
  if (preferredId && preferredId !== "unknown") return preferredId;

  try {
    const sessResult = await client.session.list();
    const sessions = sessResult?.data;
    if (!Array.isArray(sessions) || sessions.length === 0) return null;

    // Filter out subagent sessions (those with parentID)
    const rootSessions = sessions.filter((s) => !s.parentID);
    if (rootSessions.length === 0) return null;

    // Check which sessions are idle (absent from status map = idle)
    try {
      const statusResult = await client.session.status();
      const statuses = statusResult?.data;
      if (statuses && typeof statuses === "object") {
        // Find the first root session that is idle (not in the busy/retry map)
        const idleSession = rootSessions.find((s) => !statuses[s.id]);
        if (idleSession) return idleSession.id;
      }
    } catch (_) { /* status endpoint failed, fall through */ }

    // Fallback: use the most recent root session regardless of status
    // (promptAsync queues internally if the session is busy)
    return rootSessions[0].id;
  } catch (_) { return null; }
}

async function _doInjectPendingPrompts(client, idleSessionId) {
  if (_injecting || !client) return;
  _injecting = true;
  try {
    const resp = await fetch(\`\${API_URL}/prompts/pending\`, {
      headers: { "Authorization": \`Bearer \${TOKEN}\` },
    });
    if (!resp.ok) return;
    const body = await resp.json();
    const prompts = body?.data;
    if (!Array.isArray(prompts) || prompts.length === 0) return;

    for (const prompt of prompts) {
      // Resolve target: prompt's own sessionId > idleSessionId from event > auto-discover
      const targetId = await findTargetSession(
        client,
        (prompt.sessionId && prompt.sessionId !== "unknown") ? prompt.sessionId : idleSessionId,
      );
      if (!targetId) continue;

      try {
        if (prompt.isCommand && prompt.commandName) {
          // Execute as a slash command via the dedicated command API
          const cmdArgs = prompt.content.startsWith("/")
            ? prompt.content.slice(1 + prompt.commandName.length).trim()
            : "";
          await client.session.command({
            path: { id: targetId },
            body: { command: prompt.commandName, arguments: cmdArgs },
          });
        } else {
          await client.session.promptAsync({
            path: { id: targetId },
            body: {
              parts: [{ type: "text", text: prompt.content }],
            },
          });
        }

        // ACK the prompt as delivered
        await fetch(\`\${API_URL}/prompts/\${prompt.id}/ack\`, {
          method: "POST",
          headers: {
            "Authorization": \`Bearer \${TOKEN}\`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "delivered" }),
        });
      } catch (err) {
        // ACK as failed so it doesn't get retried forever
        try {
          await fetch(\`\${API_URL}/prompts/\${prompt.id}/ack\`, {
            method: "POST",
            headers: {
              "Authorization": \`Bearer \${TOKEN}\`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: "failed", error: String(err) }),
          });
        } catch (_) { /* best-effort */ }
      }
    }
  } catch (_) { /* best-effort */ }
  finally { _injecting = false; }
}

// ---------------------------------------------------------------------------
// SSE prompt stream: real-time prompt delivery from the Conduit API.
// When a prompt is queued on the dashboard, the SSE stream pushes it here
// immediately instead of waiting for the next session.idle poll.
// ---------------------------------------------------------------------------

function startPromptStream(client) {
  if (!client) return;
  let backoff = 1000;
  const MAX_BACKOFF = 30000;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    try {
      const res = await fetch(\`\${API_URL}/prompts/stream\`, {
        headers: { "Authorization": \`Bearer \${TOKEN}\` },
      });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      backoff = 1000;

      const decoder = new TextDecoder();
      let buffer = "";
      const reader = res.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\\n\\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;
          let eventType = "";
          let data = "";
          for (const line of frame.split("\\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (eventType === "prompt.queued" && data) {
            // A prompt just arrived — inject it immediately.
            // Pass the sessionId from the event so the prompt is routed to the
            // correct session rather than auto-discovered (Bug B fix).
            let queuedSessionId: string | null = null;
            try {
              const parsed = JSON.parse(data);
              queuedSessionId = parsed?.sessionId ?? null;
            } catch (_) { /* ignore parse errors */ }
            injectPendingPrompts(client, queuedSessionId);
          }
        }
      }
    } catch (_) { /* reconnect */ }

    if (!stopped) {
      setTimeout(() => connect(), backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  connect();
  // No cleanup needed — plugin lifetime = process lifetime
}

export const ConduitPlugin = ({ client }) => {
  // All startup work is deferred so the plugin returns immediately and does
  // not block OpenCode's plugin loader. Awaiting client APIs (e.g. provider.list)
  // during plugin init causes a deadlock: OpenCode waits for the plugin to finish
  // while the plugin waits for OpenCode's internals to be ready.
  setTimeout(async () => {
    try {
      const { hostname } = await import("node:os");
      const name = hostname() || "opencode";
      // OPENCODE_URL is set by OpenCode in the plugin process environment and
      // points to its own HTTP server (e.g. http://127.0.0.1:4096).
      // Passing it lets the Conduit server use direct HTTP injection (Path A)
      // instead of the unreliable SSE -> poll -> promptAsync chain (Path B).
      const opencodeUrl = process.env["OPENCODE_URL"] ?? null;
      // Fetch the OpenCode CLI version from its local HTTP API before registering.
      let version: string | null = null;
      if (opencodeUrl) {
        try {
          const healthResp = await fetch(\`\${opencodeUrl}/global/health\`);
          if (healthResp.ok) {
            const health = await healthResp.json();
            version = health?.version ?? null;
          }
        } catch (_) { /* best-effort */ }
      }
      await fetch(\`\${API_URL}/instances/register\`, {
        method: "POST",
        headers: { "Authorization": \`Bearer \${TOKEN}\`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, type: "opencode", url: opencodeUrl, version }),
      });
    } catch (_) { /* best-effort */ }

    await syncConfigToConduit();
    await syncModelsToConduit(client);
    await applyPendingConfig(client);

    // Start the real-time SSE prompt stream for immediate delivery
    startPromptStream(client);

    // Check for any prompts that were queued before the plugin started
    setTimeout(() => injectPendingPrompts(client, null), 2000);
  }, 0);

  return {
    event: async ({ event }) => {
      const t = event.type;

      // session.idle, session.error, session.compacted are state-change events —
      // flush the buffer first so all preceding events arrive at the server before
      // the dashboard reads the updated session state, then send the trigger event
      // directly (not queued) to preserve ordering.
      if (t === "session.idle" || t === "session.error" || t === "session.compacted") {
        await _flushQueue();
        const props = event.properties ?? {};
        const sessionId = t === "session.compacted"
          ? (props.sessionID ?? props.sessionId ?? "unknown")
          : extractSessionId(t, props);
        await send(t, sessionId, props);

        if (t === "session.idle") {
          injectPendingPrompts(client, props.sessionID ?? null);
        }
        return;
      }

      if (
        t === "session.created" || t === "session.updated" ||
        t === "message.updated" || t === "message.part.updated" ||
        t === "tool.execute.after" || t === "todo.updated" || t === "mcp.tools.changed"
      ) {
        const props = event.properties ?? {};
        const sessionId = extractSessionId(t, props);
        enqueue(t, sessionId, props);

        // Detect compaction start from message.part.updated with a compaction part.
        // Queue this synthetic event too — it doesn't need immediate delivery.
        if (t === "message.part.updated") {
          const part = props.info?.part ?? props.part;
          if (part && part.type === "compaction") {
            enqueue("session.compacting", sessionId, props);
          }
        }
      }
    },
  };
};
`;
}
