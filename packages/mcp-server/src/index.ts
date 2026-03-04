#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, platform, hostname } from "node:os";
import { createHmac } from "node:crypto";
import { generateOpenCodePluginSource } from "@conduit/shared";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Config — resolved from env vars that the user sets in their MCP config
//
// Required:
//   CONDUIT_API_URL      — Full base URL of the Conduit API server
//   CONDUIT_HOOK_TOKEN   — Auth token for API access
//
// Optional:
//   CONDUIT_INSTANCE_NAME — Human-readable name for this instance (default: hostname)
//   CONDUIT_INSTANCE_TYPE — Agent type override; auto-detected when not set
//   CONDUIT_SKIP_BOOTSTRAP — Set to "1" to skip auto-installing push hooks
//
// Auto-detection priority (when CONDUIT_INSTANCE_TYPE is not set):
//   1. OPENCODE=1 env var  — OpenCode injects this into every child process it spawns
//   2. ~/.claude/ exists   — Claude Code's config directory is present
//   3. fallback            — "unknown"
// ---------------------------------------------------------------------------

const API_URL = process.env["CONDUIT_API_URL"] ?? "";
const HOOK_TOKEN = process.env["CONDUIT_HOOK_TOKEN"] ?? "";
const INSTANCE_NAME =
  process.env["CONDUIT_INSTANCE_NAME"] ?? hostname() ?? "mcp-client";
const SKIP_BOOTSTRAP = process.env["CONDUIT_SKIP_BOOTSTRAP"] === "1";

/**
 * Detect which agent is running this MCP server.
 * Priority: explicit env override → OpenCode env signal → Claude Code dir → unknown.
 */
function detectInstanceType(): "opencode" | "claude-code" | "unknown" {
  const explicit = process.env["CONDUIT_INSTANCE_TYPE"];
  if (explicit === "opencode" || explicit === "claude-code") return explicit;

  // OpenCode sets OPENCODE=1 in the environment of every child process it spawns.
  // This is the most reliable signal — no process inspection needed.
  if (process.env["OPENCODE"] === "1") return "opencode";

  // Claude Code creates ~/.claude/ on first run.
  if (existsSync(join(homedir(), ".claude"))) return "claude-code";

  return "unknown";
}

const INSTANCE_TYPE = detectInstanceType();

/**
 * Detect the version of the CLI agent running this MCP server.
 * - OpenCode:    fetch {OPENCODE_URL}/global/health → .version
 * - Claude Code: read CLAUDE_CODE_VERSION env var, or spawn `claude --version`
 * Falls back to the MCP package version if nothing else works.
 */
async function detectCliVersion(): Promise<string> {
  if (INSTANCE_TYPE === "opencode") {
    const opencodeUrl = process.env["OPENCODE_URL"];
    if (opencodeUrl) {
      try {
        const res = await fetch(`${opencodeUrl}/global/health`);
        if (res.ok) {
          const body = await res.json() as { version?: string };
          if (body.version) return body.version;
        }
      } catch { /* fall through */ }
    }
  } else {
    // Claude Code sets CLAUDE_CODE_VERSION in the process environment
    const envVersion = process.env["CLAUDE_CODE_VERSION"];
    if (envVersion) return envVersion;

    // Fallback: spawn `claude --version` and parse e.g. "2.1.63 (Claude Code)"
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 3000 });
      const match = stdout.trim().match(/^(\S+)/);
      if (match?.[1]) return match[1];
    } catch { /* fall through */ }
  }
  return PKG_VERSION;
}

function log(msg: string): void {
  process.stderr.write(`[conduit-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Validate API URL to prevent SSRF to internal/cloud metadata endpoints.
// Allow https: always; allow http: only for localhost/loopback (development).
// Returns an error string if invalid, null if valid.
// ---------------------------------------------------------------------------
function validateConfig(): string | null {
  if (!API_URL) {
    return (
      "CONDUIT_API_URL environment variable is required.\n" +
      "Set it to the base URL of your Conduit server (e.g. https://your-conduit-server.example.com)."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(API_URL);
  } catch {
    return "CONDUIT_API_URL is not a valid URL.";
  }

  const proto = parsed.protocol;
  const host = parsed.hostname;

  // Block known cloud metadata IPs / link-local ranges
  const BLOCKED_HOSTS = [
    "169.254.169.254", // AWS / GCP / Azure metadata
    "metadata.google.internal",
    "metadata.internal",
    "100.100.100.200", // Alibaba metadata
    "[fd00:ec2::254]", // AWS IMDSv2 IPv6
  ];

  if (BLOCKED_HOSTS.includes(host)) {
    return (
      `CONDUIT_API_URL points to a blocked internal address (${host}). ` +
      "This is a potential SSRF vector."
    );
  }

  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";

  if (proto === "http:" && !isLoopback) {
    return (
      "CONDUIT_API_URL uses http:// for a non-localhost host. " +
      "Use https:// to protect credentials in transit."
    );
  }

  if (proto !== "http:" && proto !== "https:") {
    return `CONDUIT_API_URL uses unsupported protocol "${proto}". Only http: (localhost) and https: are allowed.`;
  }

  if (!HOOK_TOKEN) {
    return (
      "CONDUIT_HOOK_TOKEN environment variable is required.\n" +
      "Get your hook token from the Conduit dashboard under Settings."
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = homedir();
const IS_WIN = platform() === "win32";

async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T; configError?: string }> {
  if (_configError) {
    return { ok: false, status: 0, data: null as unknown as T, configError: _configError };
  }
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${HOOK_TOKEN}`,
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(url, { ...opts, headers }); // codeql[js/file-access-to-http] — server-to-server; API_URL from env config
  let data: T;
  try {
    const json = (await res.json()) as { data: T };
    data = json.data !== undefined ? json.data : (json as unknown as T);
  } catch {
    data = null as unknown as T;
  }
  return { ok: res.ok, status: res.status, data };
}

function formatError(status: number, data: unknown, configError?: string): string {
  if (configError) {
    return `Conduit is not configured: ${configError}`;
  }
  if (typeof data === "object" && data !== null && "error" in data) {
    return `HTTP ${status}: ${(data as { error: string }).error}`;
  }
  return `HTTP ${status}: ${JSON.stringify(data)}`;
}

// ---------------------------------------------------------------------------
// Auto-bootstrap: install push hooks for detected agents
// ---------------------------------------------------------------------------

/** Generate the OpenCode plugin JS that forwards events via HMAC-signed webhooks
 *  AND injects pending prompts from the Conduit dashboard into the active session
 *  using the OpenCode plugin SDK's `client.session.promptAsync()`. */
function openCodePluginJS(): string {
  return generateOpenCodePluginSource(HOOK_TOKEN, API_URL);
}

/** Generate the Claude Code bash hook helper script. */
function claudeCodeBashHook(): string {
  return `#!/usr/bin/env bash
# Conduit hook helper — auto-generated by @conduit-ai/mcp-server
set -euo pipefail

TOKEN=${JSON.stringify(HOOK_TOKEN)}
API_URL=${JSON.stringify(API_URL)}

BODY=$(cat)
[[ -z "$BODY" ]] && exit 0

EVENT=$(printf '%s' "$BODY" | grep -o '"hook_event_name":"[^"]*"' | sed 's/.*:"\\([^"]*\\)".*/\\1/' || echo "PostToolUse")
SESSION=$(printf '%s' "$BODY" | grep -o '"session_id":"[^"]*"'    | sed 's/.*:"\\([^"]*\\)".*/\\1/' || echo "unknown")
ISO_NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
TS=$(date +%s)000

PAYLOAD="{\\"event\\":\\"$EVENT\\",\\"timestamp\\":\\"$ISO_NOW\\",\\"sessionId\\":\\"$SESSION\\",\\"data\\":$BODY}"
SIG=$(printf '%s' "\${TS}.\${PAYLOAD}" | openssl dgst -sha256 -hmac "$TOKEN" -hex | awk '{print $NF}')

curl -sX POST "\${API_URL}/hooks" \\
  -H "Authorization: Bearer \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  -H "X-Conduit-Timestamp: \${TS}" \\
  -H "X-Conduit-Signature: sha256=\${SIG}" \\
  -d "\${PAYLOAD}" > /dev/null 2>&1 || true

# ── Inject pending prompts from the Conduit dashboard ──────────────────────
#
# UserPromptSubmit (sync hook): stdout is added as context before Claude
#   processes the user's input — plain text works here.
#
# Stop (sync hook): plain text stdout is only shown in verbose mode and Claude
#   ignores it. Instead we use decision:"block" + reason to prevent Claude from
#   stopping and inject the dashboard prompt as the reason to continue.
#   We guard against infinite loops with stop_hook_active from the hook input.
#
if [[ "$EVENT" == "UserPromptSubmit" ]]; then
  PROMPTS_RESP=$(curl -sf "\${API_URL}/prompts/pending" \\
    -H "Authorization: Bearer \${TOKEN}" 2>/dev/null || echo "")
  if [[ -n "$PROMPTS_RESP" ]]; then
    python3 - <<'PYEOF' "\${PROMPTS_RESP}" "\${API_URL}" "\${TOKEN}" || true
import json, sys, urllib.request

resp_json, api_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    body = json.loads(resp_json)
    prompts = (body.get('data') or [])
    if not prompts:
        sys.exit(0)
    lines = []
    for p in prompts:
        content = (p.get('content') or '').strip()
        pid = p.get('id', '')
        if content:
            lines.append(f"[Conduit dashboard prompt]: {content}")
            try:
                req = urllib.request.Request(
                    f"{api_url}/prompts/{pid}/ack",
                    data=json.dumps({"status": "delivered"}).encode(),
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass
    if lines:
        print("\\n".join(lines))
except Exception:
    pass
PYEOF
  fi
fi

if [[ "$EVENT" == "Stop" ]]; then
  # Read stop_hook_active from the hook input to prevent infinite loops.
  # When true, Claude is already continuing due to a previous Stop hook —
  # let it stop this time regardless of pending prompts.
  STOP_HOOK_ACTIVE=$(printf '%s' "$BODY" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('true' if d.get('stop_hook_active') else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")

  if [[ "$STOP_HOOK_ACTIVE" != "true" ]]; then
    PROMPTS_RESP=$(curl -sf "\${API_URL}/prompts/pending" \\
      -H "Authorization: Bearer \${TOKEN}" 2>/dev/null || echo "")
    if [[ -n "$PROMPTS_RESP" ]]; then
      python3 - <<'PYEOF' "\${PROMPTS_RESP}" "\${API_URL}" "\${TOKEN}" || true
import json, sys, urllib.request

resp_json, api_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    body = json.loads(resp_json)
    prompts = (body.get('data') or [])
    if not prompts:
        sys.exit(0)
    lines = []
    for p in prompts:
        content = (p.get('content') or '').strip()
        pid = p.get('id', '')
        if content:
            lines.append(f"[Conduit dashboard prompt]: {content}")
            try:
                req = urllib.request.Request(
                    f"{api_url}/prompts/{pid}/ack",
                    data=json.dumps({"status": "delivered"}).encode(),
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass
    if lines:
        # Output decision:block JSON — prevents Claude from stopping and
        # feeds the dashboard prompt as the reason to continue.
        reason = "\\n".join(lines)
        print(json.dumps({"decision": "block", "reason": reason}))
except Exception:
    pass
PYEOF
    fi
  fi
fi

if [[ "$EVENT" == "SessionStart" ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  if [[ -f "$SETTINGS" ]]; then
    CONFIG_CONTENT=$(cat "$SETTINGS")
    ISO2=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    TS2=$(date +%s)000
    # Include the real session_id so the server can resolve the correct instance
    # even when multiple Claude Code instances are registered for the same user.
    CONFIG_PAYLOAD="{\\"event\\":\\"config.sync\\",\\"timestamp\\":\\"$ISO2\\",\\"sessionId\\":\\"$SESSION\\",\\"data\\":{\\"agentType\\":\\"claude-code\\",\\"content\\":$(python3 -c "import sys,json; print(json.dumps(open(sys.argv[1]).read()))" "$SETTINGS")}}"
    SIG2=$(printf '%s' "\${TS2}.\${CONFIG_PAYLOAD}" | openssl dgst -sha256 -hmac "$TOKEN" -hex | awk '{print $NF}')
    curl -sX POST "\${API_URL}/hooks" \\
      -H "Authorization: Bearer \${TOKEN}" \\
      -H "Content-Type: application/json" \\
      -H "X-Conduit-Timestamp: \${TS2}" \\
      -H "X-Conduit-Signature: sha256=\${SIG2}" \\
      -d "\${CONFIG_PAYLOAD}" > /dev/null 2>&1 || true
  fi

  # Pass ?sessionId= so the server resolves the exact instance for this machine.
  PENDING=$(curl -sf "\${API_URL}/config/pending?sessionId=\${SESSION}" \\
    -H "Authorization: Bearer \${TOKEN}" 2>/dev/null || echo "")
  if [[ -n "$PENDING" ]]; then
    python3 - <<'CFGPYEOF' "\${PENDING}" "\${API_URL}" "\${TOKEN}" "\${SETTINGS}" || true
import json, sys, urllib.request

pending_json, api_url, token, settings_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    body = json.loads(pending_json)
    data = body.get('data') or {}
    content = data.get('content')
    instance_id = data.get('instanceId', '')
    if not content:
        sys.exit(0)
    import os
    os.makedirs(os.path.dirname(settings_path) or '.', exist_ok=True)
    with open(settings_path, 'w', encoding='utf-8') as f:
        f.write(content)
    # Ack with the specific instanceId so only this instance's pending row is cleared
    req = urllib.request.Request(
        f"{api_url}/config/ack",
        data=json.dumps({"instanceId": instance_id}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)
except Exception:
    pass
CFGPYEOF
  fi
fi
`;
}

/** Generate the Claude Code PowerShell hook helper script. */
function claudeCodePs1Hook(): string {
  return `# Conduit hook helper — auto-generated by @conduit-ai/mcp-server
$ErrorActionPreference = "SilentlyContinue"

$TOKEN   = ${JSON.stringify(HOOK_TOKEN)}
$API_URL = ${JSON.stringify(API_URL)}

$rawBody = [Console]::In.ReadToEnd()
if (-not $rawBody.Trim()) { exit 0 }

try { $hook = $rawBody | ConvertFrom-Json } catch { exit 0 }

$event   = if ($hook.hook_event_name) { $hook.hook_event_name } else { "PostToolUse" }
$session = if ($hook.session_id)      { $hook.session_id }      else { "unknown" }
$isoNow  = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
$ts      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$payload = [ordered]@{
  event     = $event
  timestamp = $isoNow
  sessionId = $session
  data      = $hook
} | ConvertTo-Json -Depth 20 -Compress

$sigInput = "$ts.$payload"
$keyBytes = [System.Text.Encoding]::UTF8.GetBytes($TOKEN)
$msgBytes = [System.Text.Encoding]::UTF8.GetBytes($sigInput)
$hmac     = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = $keyBytes
$sig      = ($hmac.ComputeHash($msgBytes) | ForEach-Object { $_.ToString("x2") }) -join ""

try {
  Invoke-RestMethod -Method Post \`
    -Uri "$API_URL/hooks" \`
    -Headers @{
      "Authorization"       = "Bearer $TOKEN"
      "X-Conduit-Timestamp" = "$ts"
      "X-Conduit-Signature" = "sha256=$sig"
    } \`
    -ContentType "application/json" \`
    -Body $payload | Out-Null
} catch { }

# ── Inject pending prompts from the Conduit dashboard ──────────────────────
#
# UserPromptSubmit (sync hook): stdout is added as context before Claude
#   processes the user's input — plain text works here.
#
# Stop (sync hook): plain text stdout is only shown in verbose mode.
#   Use decision:"block" + reason to prevent Claude stopping and inject
#   the dashboard prompt. Guard with stop_hook_active to avoid infinite loops.
#
if ($event -eq "UserPromptSubmit") {
  try {
    $pendingResp = Invoke-RestMethod -Uri "$API_URL/prompts/pending" \`
      -Headers @{ "Authorization" = "Bearer $TOKEN" }
    $prompts = $pendingResp.data
    if ($prompts) {
      foreach ($p in $prompts) {
        $content = ($p.content -as [string]).Trim()
        $pid = $p.id -as [string]
        if ($content) {
          Write-Output "[Conduit dashboard prompt]: $content"
          try {
            Invoke-RestMethod -Method Post \`
              -Uri "$API_URL/prompts/$pid/ack" \`
              -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
              -ContentType "application/json" \`
              -Body '{"status":"delivered"}' | Out-Null
          } catch { }
        }
      }
    }
  } catch { }
}

if ($event -eq "Stop") {
  # Guard against infinite loops: if stop_hook_active is true, Claude is
  # already continuing due to a previous Stop hook — let it stop this time.
  $stopHookActive = $false
  try { $stopHookActive = [bool]$hook.stop_hook_active } catch { }

  if (-not $stopHookActive) {
    try {
      $pendingResp = Invoke-RestMethod -Uri "$API_URL/prompts/pending" \`
        -Headers @{ "Authorization" = "Bearer $TOKEN" }
      $prompts = $pendingResp.data
      if ($prompts) {
        $lines = [System.Collections.Generic.List[string]]::new()
        foreach ($p in $prompts) {
          $content = ($p.content -as [string]).Trim()
          $pid = $p.id -as [string]
          if ($content) {
            $lines.Add("[Conduit dashboard prompt]: $content")
            try {
              Invoke-RestMethod -Method Post \`
                -Uri "$API_URL/prompts/$pid/ack" \`
                -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
                -ContentType "application/json" \`
                -Body '{"status":"delivered"}' | Out-Null
            } catch { }
          }
        }
        if ($lines.Count -gt 0) {
          # Output decision:block JSON — prevents Claude from stopping and
          # feeds the dashboard prompt as the reason to continue.
          $reason = $lines -join "\`n"
          $blockJson = [ordered]@{ decision = "block"; reason = $reason } | ConvertTo-Json -Compress
          Write-Output $blockJson
        }
      }
    } catch { }
  }
}

if ($event -eq "SessionStart") {
  $settingsPath = "$env:USERPROFILE\\.claude\\settings.json"
  if (Test-Path $settingsPath) {
    try {
      $configRaw = Get-Content $settingsPath -Raw
      $configEscaped = $configRaw | ConvertTo-Json -Compress
      $isoNow2 = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
      $ts2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      # Include real session_id and agentType so server resolves the correct instance
      $configPayload = '{"event":"config.sync","timestamp":"' + $isoNow2 + '","sessionId":"' + $session + '","data":{"agentType":"claude-code","content":' + $configEscaped + '}}'
      $msgBytes2 = [System.Text.Encoding]::UTF8.GetBytes("$ts2.$configPayload")
      $hmac2 = New-Object System.Security.Cryptography.HMACSHA256
      $hmac2.Key = $keyBytes
      $sig2 = ($hmac2.ComputeHash($msgBytes2) | ForEach-Object { $_.ToString("x2") }) -join ""
      Invoke-RestMethod -Method Post -Uri "$API_URL/hooks" \`
        -Headers @{ "Authorization" = "Bearer $TOKEN"; "X-Conduit-Timestamp" = "$ts2"; "X-Conduit-Signature" = "sha256=$sig2" } \`
        -ContentType "application/json" -Body $configPayload | Out-Null
    } catch { }
  }

  # Pass ?sessionId= so the server resolves the correct instance for this machine
  try {
    $pending = Invoke-RestMethod -Uri "$API_URL/config/pending?sessionId=$session" \`
      -Headers @{ "Authorization" = "Bearer $TOKEN" }
    $pendingContent = $pending.data.content
    $pendingInstanceId = $pending.data.instanceId
    if ($pendingContent) {
      New-Item -ItemType Directory -Force -Path (Split-Path $settingsPath) | Out-Null
      Set-Content -Path $settingsPath -Value $pendingContent -Encoding UTF8
      # Ack with the specific instanceId so only this instance's pending row is cleared
      $ackBody = if ($pendingInstanceId) { '{"instanceId":"' + $pendingInstanceId + '"}' } else { '{}' }
      Invoke-RestMethod -Method Post -Uri "$API_URL/config/ack" \`
        -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
        -ContentType "application/json" -Body $ackBody | Out-Null
    }
  } catch { }
}
`;
}

/**
 * Auto-detect installed agents and install push hooks.
 * Runs once on MCP server startup, best-effort (never throws).
 */
async function bootstrapPushHooks(): Promise<void> {
  // ── OpenCode plugin ─────────────────────────────────────────────────────
  const xdg = process.env["XDG_CONFIG_HOME"];
  const ocDir = xdg
    ? join(xdg, "opencode", "plugins")
    : join(HOME, ".config", "opencode", "plugins");

  // Install if the opencode config dir exists (user has opencode) or the
  // plugins dir already exists
  const ocConfigDir = dirname(ocDir); // ~/.config/opencode
  if (existsSync(ocConfigDir)) {
    try {
      await mkdir(ocDir, { recursive: true });
      const pluginPath = join(ocDir, "conduit.js");
      const desired = openCodePluginJS();
      // Only write if content changed — avoids triggering OpenCode's plugin
      // file watcher on every MCP server startup, which causes a black screen.
      let existing = "";
      try { existing = await readFile(pluginPath, "utf8"); } catch { /* not yet installed */ }
      if (existing !== desired) {
        await writeFile(pluginPath, desired, "utf8");
        // Restrict permissions — file contains HOOK_TOKEN in plaintext
        if (!IS_WIN) await chmod(pluginPath, 0o600);
        log(`OpenCode plugin installed -> ${pluginPath}`);
      } else {
        log(`OpenCode plugin up to date -> ${pluginPath}`);
      }
    } catch (err) {
      log(`Failed to install OpenCode plugin: ${err}`);
    }
  }

  // ── Claude Code hooks ───────────────────────────────────────────────────
  const claudeDir = join(HOME, ".claude");
  if (existsSync(claudeDir)) {
    try {
      // Write the hook helper script (only if content changed)
      if (IS_WIN) {
        const helperPath = join(HOME, ".conduit-hook.ps1");
        const desired = claudeCodePs1Hook();
        let existing = "";
        try { existing = await readFile(helperPath, "utf8"); } catch { /* not yet installed */ }
        if (existing !== desired) {
          await writeFile(helperPath, desired, "utf8");
          log(`Claude Code hook helper installed -> ${helperPath}`);
        }
        // Merge into settings.json
        const settingsPath = join(claudeDir, "settings.json");
        const hookCmd = `powershell -NonInteractive -ExecutionPolicy Bypass -File "${helperPath}"`;
        await mergeClaudeSettings(settingsPath, hookCmd);
      } else {
        const helperPath = join(HOME, ".conduit-hook");
        const desired = claudeCodeBashHook();
        let existing = "";
        try { existing = await readFile(helperPath, "utf8"); } catch { /* not yet installed */ }
        if (existing !== desired) {
          // 0o700: owner-only read/write/execute — file contains HOOK_TOKEN
          await writeFile(helperPath, desired, { mode: 0o700 });
          log(`Claude Code hook helper installed -> ${helperPath}`);
        }
        // Merge into settings.json
        const settingsPath = join(claudeDir, "settings.json");
        await mergeClaudeSettings(settingsPath, helperPath);
      }
    } catch (err) {
      log(`Failed to install Claude Code hooks: ${err}`);
    }
  }
}

/** Merge Conduit hook entries into Claude Code's settings.json. */
async function mergeClaudeSettings(
  settingsPath: string,
  hookCmd: string,
): Promise<void> {
  let cfg: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid JSON — start fresh
  }

  const hooks = (cfg["hooks"] ?? {}) as Record<string, unknown[]>;
  cfg["hooks"] = hooks;

  // PostToolUse and SessionStart are telemetry-only — run async so they don't block Claude.
  // Stop and UserPromptSubmit must be synchronous so Claude Code waits for their output:
  //   UserPromptSubmit: stdout is added as context before Claude processes the user prompt.
  //   Stop: can return { decision: "block", reason: "..." } to prevent Claude stopping and
  //         inject a dashboard prompt as the reason to continue.
  const asyncHookEntry = { type: "command", command: hookCmd, async: true };
  const syncHookEntry  = { type: "command", command: hookCmd };

  const eventConfig: Record<string, { matcher?: string; entry: typeof asyncHookEntry | typeof syncHookEntry }> = {
    PostToolUse:        { matcher: "*",   entry: asyncHookEntry },
    SessionStart:       {                 entry: asyncHookEntry },
    UserPromptSubmit:   {                 entry: syncHookEntry  },
    Stop:               {                 entry: syncHookEntry  },
  };

  for (const [event, { matcher, entry }] of Object.entries(eventConfig)) {
    const list = (hooks[event] ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string }>;
    }>;

    // Remove any existing conduit-hook entries
    const filtered = list.filter((block) => {
      const innerHooks = block.hooks ?? [];
      return !innerHooks.some(
        (h) => h.command && h.command.includes("conduit-hook"),
      );
    });

    // Add fresh entry
    const block = matcher !== undefined
      ? { matcher, hooks: [entry] }
      : { hooks: [entry] };
    filtered.push(block);
    hooks[event] = filtered;
  }

  await writeFile(settingsPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  log(`Claude Code settings updated -> ${settingsPath}`);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

// Set after main() validates config. Tool handlers check this before doing
// anything so they return a clear error instead of crashing when env vars
// are missing or incorrect.
let _configError: string | null = null;

const server = new McpServer({
  name: "Conduit",
  version: PKG_VERSION,
});

// ---- Tool: register_instance ----
server.registerTool(
  "register_instance",
  {
    description:
      "Register this agent instance with the Conduit dashboard so it can be tracked and receive prompts.",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          "Human-readable instance name (default: env CONDUIT_INSTANCE_NAME)",
        ),
      type: z
        .enum([
          "opencode",
          "claude-code",
          "copilot",
          "cursor",
          "windsurf",
          "other",
        ])
        .optional()
        .describe("Agent type (default: env CONDUIT_INSTANCE_TYPE)"),
      version: z.string().optional().describe("Agent version string"),
      url: z
        .string()
        .optional()
        .describe("URL where the agent is reachable, if any"),
    },
  },
  async ({ name, type, version, url }) => {
    const body = {
      name: name ?? INSTANCE_NAME,
      type: type ?? INSTANCE_TYPE,
      version: version ?? null,
      url: url ?? null,
    };
    const res = await api("/instances/register", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Registered instance "${body.name}" (type: ${body.type}). Instance ID: ${JSON.stringify(res.data)}`,
        },
      ],
    };
  },
);

// ---- Tool: check_prompts ----
server.registerTool(
  "check_prompts",
  {
    description:
      "Check for pending prompts sent from the Conduit dashboard that are waiting for this agent to execute.",
  },
  async () => {
    const res = await api<
      Array<{
        id: string;
        sessionId: string;
        content: string;
        createdAt: string;
      }>
    >("/prompts/pending");
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    const prompts = Array.isArray(res.data) ? res.data : [];
    if (prompts.length === 0) {
      return { content: [{ type: "text", text: "No pending prompts." }] };
    }
    const lines = prompts.map(
      (p) =>
        `- [${p.id}] session=${p.sessionId} | "${p.content}" (queued ${p.createdAt})`,
    );
    return {
      content: [
        {
          type: "text",
          text: `${prompts.length} pending prompt(s):\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ---- Tool: report_event ----
server.registerTool(
  "report_event",
  {
    description:
      "Report an event to Conduit (session created, message updated, etc.). Use this for agents that don't have native hook/plugin systems.",
    inputSchema: {
      type: z
        .string()
        .describe(
          'Event type, e.g. "session.created", "message.updated", "session.completed"',
        ),
      sessionId: z.string().describe("The session ID this event belongs to"),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arbitrary event payload (JSON object)"),
    },
  },
  async ({ type: eventType, sessionId, payload }) => {
    if (_configError) {
      return { content: [{ type: "text", text: `Conduit is not configured: ${_configError}` }] };
    }
    const ts = Date.now();
    const body = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      sessionId,
      data: payload ?? {},
    });
    const sig = createHmac("sha256", HOOK_TOKEN)
      .update(`${ts}.${body}`)
      .digest("hex");

    // Server-to-server call to Conduit API — URL from environment config, not user input.
    const res = await fetch(`${API_URL}/hooks`, { // codeql[js/file-access-to-http] — server-to-server; API_URL from env config
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HOOK_TOKEN}`,
        "x-conduit-timestamp": String(ts),
        "x-conduit-signature": `sha256=${sig}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      return {
        content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Event "${eventType}" reported for session ${sessionId}.`,
        },
      ],
    };
  },
);

// ---- Tool: list_sessions ----
server.registerTool(
  "list_sessions",
  {
    description:
      "List recent sessions tracked by Conduit. Returns session IDs, titles, status, and message counts.",
    inputSchema: {
      limit: z
        .number()
        .optional()
        .describe("Max sessions to return (default 20)"),
    },
  },
  async ({ limit }) => {
    const res = await api<{
      sessions: Array<{
        id: string;
        title: string | null;
        status: string;
        messageCount: number;
        instanceType?: string;
        updatedAt: string;
      }>;
      total: number;
    }>(`/sessions?limit=${limit ?? 20}`);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    const sessions = res.data?.sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return { content: [{ type: "text", text: "No sessions found." }] };
    }
    const total = res.data.total ?? sessions.length;
    const lines = sessions.map((s) => {
      const title = s.title ?? "(untitled)";
      const inst = s.instanceType ? " (" + s.instanceType + ")" : "";
      return "- [" + s.id + '] "' + title + '"' + inst + " — " + s.status + ", " + s.messageCount + " msgs, updated " + s.updatedAt;
    });
    return {
      content: [
        {
          type: "text",
          text: `${sessions.length} of ${total} session(s):\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ---- Tool: get_session ----
server.registerTool(
  "get_session",
  {
    description:
      "Get full details for a specific session including messages, tool calls, and token usage.",
    inputSchema: {
      sessionId: z.string().describe("The session ID to fetch"),
    },
  },
  async ({ sessionId }) => {
    const res = await api<{
      id: string;
      title: string;
      messages: Array<{
        role: string;
        text: string;
        toolCalls?: Array<{ name: string; input: unknown }>;
      }>;
      tokenUsage?: { input: number; output: number; cacheRead?: number };
    }>(`/sessions/${sessionId}`);
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res.data, null, 2),
        },
      ],
    };
  },
);

// ---- Tool: ack_prompt ----
server.registerTool(
  "ack_prompt",
  {
    description: "Acknowledge a pending prompt after it has been processed.",
    inputSchema: {
      promptId: z.string().describe("The prompt ID to acknowledge"),
      status: z
        .enum(["delivered", "failed"])
        .optional()
        .describe("Ack status (default: delivered)"),
      error: z
        .string()
        .optional()
        .describe("Error message if status is failed"),
    },
  },
  async ({ promptId, status, error }) => {
    const body = {
      status: status ?? "delivered",
      error: error ?? undefined,
    };
    const res = await api(`/prompts/${promptId}/ack`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Prompt ${promptId} acknowledged as "${body.status}".`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Provider model fetching — called on startup to populate the Conduit model picker
// with whatever models are actually available to the user's configured provider.
// Falls back to CLAUDE_MODELS (built-in Anthropic catalogue) if detection fails.
// ---------------------------------------------------------------------------

interface ModelEntry {
  providerId: string;
  modelId: string;
  modelName: string;
}

/** Fetch models from the Anthropic API (direct or compatible proxy). */
async function fetchAnthropicModels(apiKey: string, baseUrl: string): Promise<ModelEntry[] | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models?limit=1000`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
    if (!Array.isArray(json.data) || json.data.length === 0) return null;
    return json.data.map(m => ({
      providerId: 'anthropic',
      modelId: m.id,
      modelName: m.display_name ?? m.id,
    }));
  } catch {
    return null;
  }
}

/** Fetch models from OpenRouter. Model IDs are in "provider/model" format. */
async function fetchOpenRouterModels(apiKey: string, baseUrl: string): Promise<ModelEntry[] | null> {
  try {
    // baseUrl is typically "https://openrouter.ai/api/v1" — derive origin for models endpoint
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: Array<{ id: string; name?: string }> };
    if (!Array.isArray(json.data) || json.data.length === 0) return null;
    return json.data.map(m => {
      // IDs are like "anthropic/claude-3-5-sonnet", "openai/gpt-4o", etc.
      const slash = m.id.indexOf('/');
      const providerId = slash !== -1 ? m.id.slice(0, slash) : 'openrouter';
      return {
        providerId,
        modelId: m.id,
        modelName: m.name ?? m.id,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Detect the configured provider from env vars and fetch the real model list.
 * Returns null if detection is impossible (e.g. Claude.ai login, no API key).
 */
async function fetchProviderModels(): Promise<ModelEntry[] | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) return null;

  const rawBase = (process.env['ANTHROPIC_BASE_URL'] ?? '').replace(/\/$/, '');

  // OpenRouter: ANTHROPIC_BASE_URL contains "openrouter.ai"
  if (rawBase.includes('openrouter.ai')) {
    const models = await fetchOpenRouterModels(apiKey, rawBase);
    if (models) {
      log(`Provider sync: fetched ${models.length} model(s) from OpenRouter`);
      return models;
    }
  }

  // Anthropic direct (or compatible proxy using Anthropic API format)
  const anthropicBase = rawBase || 'https://api.anthropic.com';
  const models = await fetchAnthropicModels(apiKey, anthropicBase);
  if (models) {
    log(`Provider sync: fetched ${models.length} model(s) from Anthropic API`);
    return models;
  }

  return null;
}

// ---- Tool: sync_models ----
// Built-in Claude model catalogue — used as fallback when provider API is unavailable
// (e.g. Claude.ai login without an API key, or network errors).
// Agents can pass a custom list via the `models` parameter to override.
const CLAUDE_MODELS: ModelEntry[] = [
  { providerId: "anthropic", modelId: "claude-opus-4-6",            modelName: "Claude Opus 4.6" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-6",          modelName: "Claude Sonnet 4.6" },
  { providerId: "anthropic", modelId: "claude-haiku-4-5",           modelName: "Claude Haiku 4.5" },
  { providerId: "anthropic", modelId: "claude-opus-4-5",            modelName: "Claude Opus 4.5" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-5",          modelName: "Claude Sonnet 4.5" },
  { providerId: "anthropic", modelId: "claude-opus-4-0",            modelName: "Claude Opus 4" },
  { providerId: "anthropic", modelId: "claude-sonnet-4-0",          modelName: "Claude Sonnet 4" },
  { providerId: "anthropic", modelId: "claude-haiku-4-0",           modelName: "Claude Haiku 4" },
  { providerId: "anthropic", modelId: "claude-3-7-sonnet-20250219", modelName: "Claude 3.7 Sonnet" },
  { providerId: "anthropic", modelId: "claude-3-5-sonnet-20241022", modelName: "Claude 3.5 Sonnet" },
  { providerId: "anthropic", modelId: "claude-3-5-haiku-20241022",  modelName: "Claude 3.5 Haiku" },
  { providerId: "anthropic", modelId: "claude-3-opus-20240229",     modelName: "Claude 3 Opus" },
  { providerId: "anthropic", modelId: "claude-3-sonnet-20240229",   modelName: "Claude 3 Sonnet" },
  { providerId: "anthropic", modelId: "claude-3-haiku-20240307",    modelName: "Claude 3 Haiku" },
];

async function sendConfigSync(): Promise<void> {
  // Resolve config path based on the detected agent type.
  // OpenCode: ~/.config/opencode/opencode.json (respects XDG_CONFIG_HOME and Windows USERPROFILE)
  // Claude Code: ~/.claude/settings.json
  let settingsPath: string;
  if (INSTANCE_TYPE === "opencode") {
    const xdg = process.env["XDG_CONFIG_HOME"];
    if (xdg) {
      settingsPath = join(xdg, "opencode", "opencode.json");
    } else if (IS_WIN) {
      const base = process.env["USERPROFILE"] ?? HOME;
      settingsPath = join(base, ".config", "opencode", "opencode.json");
    } else {
      settingsPath = join(HOME, ".config", "opencode", "opencode.json");
    }
  } else {
    settingsPath = join(HOME, ".claude", "settings.json");
  }

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
    if (!raw.trim()) raw = "{}";
    JSON.parse(raw); // validate it's valid JSON
  } catch {
    // OpenCode's config may not exist yet — treat as empty config rather than skipping
    if (INSTANCE_TYPE === "opencode") {
      raw = "{}";
    } else {
      log("config.sync skipped — settings.json not found or invalid");
      return;
    }
  }

  const ts = Date.now();
  const body = JSON.stringify({
    event: "config.sync",
    timestamp: new Date().toISOString(),
    sessionId: "conduit-config",
    data: { agentType: INSTANCE_TYPE, content: raw },
  });
  const sig = createHmac("sha256", HOOK_TOKEN)
    .update(`${ts}.${body}`)
    .digest("hex");

  try {
    // codeql[js/file-access-to-http] — server-to-server call; API_URL from env config.
    const res = await fetch(`${API_URL}/hooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HOOK_TOKEN}`,
        "x-conduit-timestamp": String(ts),
        "x-conduit-signature": `sha256=${sig}`,
      },
      body,
    });
    if (res.ok) {
      log(`config.sync sent — ${basename(settingsPath)} synced`);
    } else {
      const text = await res.text().catch(() => "");
      log(`config.sync failed: HTTP ${res.status} ${text}`);
    }
  } catch (err) {
    log(`config.sync error: ${err}`);
  }
}

async function sendModelsSync(models: typeof CLAUDE_MODELS): Promise<void> {
  const ts = Date.now();
  const body = JSON.stringify({
    event: "models.sync",
    timestamp: new Date().toISOString(),
    sessionId: "conduit-models",
    data: { agentType: INSTANCE_TYPE, models },
  });
  const sig = createHmac("sha256", HOOK_TOKEN)
    .update(`${ts}.${body}`)
    .digest("hex");

  try {
    // codeql[js/file-access-to-http] — server-to-server call; API_URL from env config.
    const res = await fetch(`${API_URL}/hooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HOOK_TOKEN}`,
        "x-conduit-timestamp": String(ts),
        "x-conduit-signature": `sha256=${sig}`,
      },
      body,
    });
    if (res.ok) {
      log(`models.sync sent — ${models.length} model(s) synced`);
    } else {
      const text = await res.text().catch(() => "");
      log(`models.sync failed: HTTP ${res.status} ${text}`);
    }
  } catch (err) {
    log(`models.sync error: ${err}`);
  }
}

server.registerTool(
  "sync_models",
  {
    description:
      "Sync the list of available AI models to the Conduit dashboard so the model picker shows current options. " +
      "Call this on startup or when the available model list changes. " +
      "If no models are provided, syncs the built-in Claude model catalogue.",
    inputSchema: {
      models: z
        .array(
          z.object({
            providerId: z.string().describe("Provider ID, e.g. 'anthropic'"),
            modelId: z.string().describe("Model ID, e.g. 'claude-3-5-sonnet-20241022'"),
            modelName: z.string().describe("Human-readable name, e.g. 'Claude 3.5 Sonnet'"),
          }),
        )
        .optional()
        .describe("List of models to sync. Defaults to built-in Claude model catalogue."),
    },
  },
  async ({ models }) => {
    let list: ModelEntry[];
    if (models) {
      list = models;
    } else {
      // Re-run provider auto-detection instead of using the hardcoded fallback
      const fetched = await fetchProviderModels();
      list = fetched ?? CLAUDE_MODELS;
    }
    await sendModelsSync(list);
    return {
      content: [
        {
          type: "text",
          text: `Synced ${list.length} model(s) to Conduit dashboard.`,
        },
      ],
    };
  },
);

// ---- Tool: get_metrics ----
server.registerTool(
  "get_metrics",
  {
    description:
      "Get usage metrics from Conduit: session counts, token usage, cost estimates, etc.",
    inputSchema: {
      period: z
        .enum(["today", "week", "month", "all"])
        .optional()
        .describe("Time period for metrics (default: today)"),
    },
  },
  async ({ period }) => {
    const res = await api<Record<string, unknown>>(
      `/metrics?period=${period ?? "today"}`,
    );
    if (!res.ok) {
      return {
        content: [{ type: "text", text: formatError(res.status, res.data, res.configError) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res.data, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Connect to the Conduit API's prompt SSE stream and forward
 * prompt.queued events as MCP logging notifications to the agent.
 *
 * Uses native fetch + ReadableStream (Node 18+) — no external deps.
 * Auto-reconnects with exponential backoff (1s → 30s).
 */
function startPromptStream(): void {
  let backoff = 1000;
  const MAX_BACKOFF = 30_000;
  let stopped = false;

  async function connect(): Promise<void> {
    if (stopped) return;
    const url = `${API_URL}/prompts/stream`;
    log(`Prompt stream: connecting to ${url}`);

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${HOOK_TOKEN}` },
      }).catch((err: Error) => {
        throw new Error(`fetch failed: ${err.message}`);
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      backoff = 1000; // reset on successful connection
      log("Prompt stream: connected");

      const decoder = new TextDecoder();
      let buffer = "";

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames: "event: <type>\ndata: <json>\n\n"
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;

          let eventType = "";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
            // Ignore comments like ":heartbeat"
          }

          if (eventType === "prompt.queued" && data) {
            try {
              const prompt = JSON.parse(data) as {
                id: string;
                sessionId: string;
                content: string;
                createdAt: string;
              };
              log(`Prompt received: [${prompt.id}] "${prompt.content.slice(0, 80)}"`);

              // Send logging notification to the agent at emergency level
              // so the agent sees the prompt and can act on it
              await server.sendLoggingMessage({
                level: "emergency",
                logger: "conduit-prompt",
                data: {
                  type: "prompt.queued",
                  promptId: prompt.id,
                  sessionId: prompt.sessionId,
                  content: prompt.content,
                  message: `[Conduit] New prompt queued from dashboard: "${prompt.content}". Use the check_prompts tool to retrieve and process it, then acknowledge with ack_prompt.`,
                },
              });

              // Immediately ack as delivered so the dashboard UI updates.
              // The agent still needs to act on the content, but the status
              // "delivered" means the notification reached the agent process.
              await api(`/prompts/${prompt.id}/ack`, {
                method: "POST",
                body: JSON.stringify({ status: "delivered" }),
              }).catch(() => {
                // Non-critical — don't let ack failure kill the stream loop
              });
            } catch (err) {
              log(`Prompt stream: failed to parse/forward prompt: ${err}`);
            }
          }
        }
      }

      log("Prompt stream: connection closed by server");
    } catch (err) {
      log(`Prompt stream: error — ${err}`);
    }

    // Reconnect with backoff
    if (!stopped) {
      log(`Prompt stream: reconnecting in ${backoff / 1000}s`);
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  // Start in the background (never blocks)
  void connect();

  // Clean up on process exit
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
}

async function main() {
  // Connect the stdio MCP transport FIRST — before any validation — so OpenCode
  // always completes the MCP initialize handshake and loads its UI normally.
  // Previously, process.exit(1) was called at module scope before the handshake,
  // leaving OpenCode waiting for a response from a dead process (black screen).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Validate config. On failure, log to stderr and keep the server alive so
  // OpenCode's UI is not blocked — tool calls will return a descriptive error.
  _configError = validateConfig();
  if (_configError) {
    log(`Error: ${_configError}`);
    // Don't exit — a dead process causes OpenCode black screen. The server
    // stays up; tool handlers check _configError and return the error message.
    return;
  }

  // Auto-bootstrap push hooks (best-effort, never blocks startup)
  if (!SKIP_BOOTSTRAP) {
    try {
      await bootstrapPushHooks();
    } catch (err) {
      log(`Bootstrap warning: ${err}`);
    }
  }

  // Register this instance with Conduit so the dashboard shows the correct type
  // immediately, without waiting for the first hook event to auto-create it.
  const cliVersion = await detectCliVersion();
  void api("/instances/register", {
    method: "POST",
    body: JSON.stringify({
      name: INSTANCE_NAME,
      type: INSTANCE_TYPE === "unknown" ? "claude-code" : INSTANCE_TYPE,
      version: cliVersion,
    }),
  }).then((res) => {
    if (res.ok) {
      log(`Instance registered (type: ${INSTANCE_TYPE}, version: ${cliVersion})`);
    } else {
      log(`Instance registration failed: HTTP ${res.status}`);
    }
  }).catch(() => {});

  // Config + model sync: always run so the dashboard is populated on first install,
  // even before the OpenCode plugin has been loaded (it's written by bootstrapPushHooks
  // above, but OpenCode only loads plugins at startup — not at runtime).
  // The OpenCode plugin will also send these on its own startup after the next restart;
  // the server upserts both gracefully so duplicate syncs are harmless.
  void sendConfigSync().catch(() => {});
  void fetchProviderModels().then(async (providerModels) => {
    await sendModelsSync(providerModels ?? CLAUDE_MODELS);
  }).catch(() => {
    void sendModelsSync(CLAUDE_MODELS);
  });

  // Heartbeat: keep the instance marked 'connected' every 60 seconds.
  // Without this, idle Claude Code sessions (no hook events for >5 min)
  // would be marked 'disconnected' by the server health checker.
  // Include the CLI version so it stays current even if detection was slow on startup.
  const heartbeatInterval = setInterval(() => {
    void api("/instances/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        type: INSTANCE_TYPE === "unknown" ? "claude-code" : INSTANCE_TYPE,
        version: cliVersion,
      }),
    }).catch(() => {});
  }, 60_000);

  process.on("SIGINT", () => { clearInterval(heartbeatInterval); });
  process.on("SIGTERM", () => { clearInterval(heartbeatInterval); });

  // Start listening for prompt events from the Conduit API
  startPromptStream();
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
