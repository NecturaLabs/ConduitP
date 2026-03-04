import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ApiError, ApiSuccess, HookPayload, HookResponse } from '@conduit/shared';
import { generateOpenCodePluginSource } from '@conduit/shared';
import { verifyHmacSignature, computeHmacSignature } from '../services/auth.js';
import { config } from '../config.js';
import { webhookRateLimit, apiReadRateLimit, apiWriteRateLimit } from '../middleware/rateLimit.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { eventBus } from '../services/eventbus.js';
import { resolveHookTokenUser, extractBearerToken } from '../middleware/hook-auth.js';
import { emitInstanceUpdated } from './instances.js';
import { createHash } from 'node:crypto';
import { pricingService } from '../services/pricing.js';

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

/**
 * Returns true when the IP is a publicly-routable address.
 * Used to detect the client's public IP for display in the hook token UI.
 * SECURITY: Always call this on request.ip (Fastify's trustProxy-resolved value),
 * never on raw X-Forwarded-For or cf-connecting-ip headers.
 */
function isPublicIp(ip: string | undefined): ip is string {
  if (!ip) return false;
  return !(
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip === '::ffff:127.0.0.1'
  );
}

// ── Device Flow store (RFC 8628 adapted) ──────────────────────────────────────
//
// 1. Terminal runs `curl ... | bash` → hits GET /install.sh (no params).
//    Returns a bootstrap script that calls POST /install/device to start the flow.
//
// 2. POST /install/device (public, rate-limited):
//    Generates user_code (8-char base-20 consonants, e.g. WDJB-MJHT) and
//    device_code (high-entropy opaque string). Stores them in memory with TTL.
//    Returns { user_code, device_code, verification_uri, expires_in, interval }.
//
// 3. Terminal prints "Visit <verification_uri> and enter code: <user_code>"
//    Then polls POST /install/poll with { device_code } every <interval> seconds.
//
// 4. User opens browser (already logged in), goes to /app/activate, enters user_code.
//    Browser calls POST /install/approve (authenticated + CSRF) with { user_code }.
//    Server marks that device_code as approved.
//
// 5. Next poll from terminal detects approval → returns the full install script
//    with the real token baked in. Script writes helper + configures settings.json.
//
// Security: nothing sensitive ever appears in a URL or shell history.

const DEVICE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEVICE_POLL_INTERVAL = 5; // seconds
const MAX_PENDING_DEVICES = 100;

// Base-20 consonant charset per RFC 8628 §6.1 recommendation
const USER_CODE_CHARSET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8; // 4+4 with dash = ~34.5 bits of entropy

function generateUserCode(): string {
  // Rejection sampling to avoid modulo bias.
  // USER_CODE_CHARSET.length = 20; largest multiple of 20 ≤ 256 is 240.
  // Bytes >= 240 are rejected so each character has exactly 12/240 = 1/20 probability.
  const charsetLen = USER_CODE_CHARSET.length;
  const maxUnbiased = Math.floor(256 / charsetLen) * charsetLen; // 240
  let code = '';
  while (code.length < USER_CODE_LENGTH) {
    const bytes = randomBytes(USER_CODE_LENGTH * 2); // over-provision to minimise loops
    for (let i = 0; i < bytes.length && code.length < USER_CODE_LENGTH; i++) {
      if (bytes[i]! < maxUnbiased) {
        code += USER_CODE_CHARSET[bytes[i]! % charsetLen];
      }
    }
  }
  return code; // stored without dash, displayed as XXXX-XXXX
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

/**
 * Maps Claude Code hook event names to their canonical SSE event types so the
 * frontend EventSource listeners (which only know OpenCode-style dotted names)
 * can handle them.  OpenCode events pass through unchanged.
 *
 * Returns null for events that should NOT be broadcast to SSE clients (e.g.
 * subagent lifecycle noise that has no meaningful frontend representation).
 */
function toSSEEventType(hookEvent: string): string | null {
  switch (hookEvent) {
    case 'SessionStart':     return 'session.created';
    case 'UserPromptSubmit': return 'message.updated';
    case 'PreToolUse':       return 'tool.started';
    case 'PostToolUse':      return 'tool.completed';
    case 'Stop':             return 'session.idle';
    case 'SessionEnd':       return 'session.idle';
    case 'TaskCompleted':    return 'session.idle';
    // Subagent lifecycle — not meaningful for the session list / detail views
    case 'SubagentStart':    return null;
    case 'SubagentStop':     return null;
    // OpenCode events and report_event calls already use dotted names → pass through
    default:                 return hookEvent;
  }
}

const hookPayloadSchema = z.object({
  event: z.union([
    // Claude Code hook events
    z.enum([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'TaskCompleted',
      'SessionEnd',
    ]),
    // OpenCode plugin events
    z.enum([
      'session.created',
      'session.updated',
      'session.idle',
      'session.error',
      'session.compacting',
      'session.compacted',
      'message.updated',
      'message.part.updated',
      'tool.execute.after',
      'todo.updated',
      'mcp.tools.changed',
      'config.sync',
      'models.sync',
    ]),
  ]),
  timestamp: z.string(),
  sessionId: z.string(),
  data: z.record(z.string(), z.unknown()).refine(
    (d) => JSON.stringify(d).length <= 500_000,
    { message: 'Hook data payload exceeds the 500KB limit' },
  ),
});

// Shell-safe assertion: token and apiUrl are interpolated into bash/PowerShell
// template literals. Token is server-generated hex, apiUrl is server config.
// This guard ensures no shell metacharacters can leak through if either source
// is ever compromised or misconfigured.
const SHELL_SAFE_RE = /^[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
function assertShellSafe(value: string, label: string): void {
  if (!SHELL_SAFE_RE.test(value)) {
    throw new Error(`Refusing to interpolate unsafe ${label} into shell script`);
  }
}

function generateBashScript(token: string, apiUrl: string): string {
  assertShellSafe(token, 'token');
  assertShellSafe(apiUrl, 'apiUrl');
  return `#!/usr/bin/env bash
# Conduit hook helper — auto-generated, do not edit.
# Reads Claude Code hook JSON from stdin, signs it with HMAC-SHA256,
# and forwards it to the Conduit API.
set -euo pipefail

TOKEN="${token}"
API_URL="${apiUrl}"

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
      -H "X-Conduit-Timestamp: \${TS2}" \\
      -H "X-Conduit-Signature: sha256=\${SIG2}" \\
      -d "\${CONFIG_PAYLOAD}" > /dev/null 2>&1 || true
  fi

  # Check for pending config update from dashboard
  PENDING=$(curl -sf "\${API_URL}/config/pending" \\
    -H "Authorization: Bearer \${TOKEN}" 2>/dev/null || echo "")
  if [[ -n "$PENDING" ]]; then
    CONTENT=$(printf '%s' "$PENDING" | python3 -c "
import json,sys
try:
  body = json.load(sys.stdin)
  c = (body.get('data') or {}).get('content')
  if c: print(c, end='')
except: pass
" 2>/dev/null || echo "")
    if [[ -n "$CONTENT" ]]; then
      mkdir -p "$(dirname "$SETTINGS")"
      printf '%s' "$CONTENT" > "$SETTINGS"
      curl -sf -X POST "\${API_URL}/config/ack" \\
        -H "Authorization: Bearer \${TOKEN}" \\
        -H "Content-Type: application/json" \\
        -d '{}' > /dev/null 2>&1 || true
    fi
  fi
fi
`;
}

function generatePowerShellScript(token: string, apiUrl: string): string {
  assertShellSafe(token, 'token');
  assertShellSafe(apiUrl, 'apiUrl');
  return `# Conduit hook helper — auto-generated, do not edit.
# Reads Claude Code hook JSON from stdin, signs it with HMAC-SHA256,
# and forwards it to the Conduit API.
$ErrorActionPreference = "SilentlyContinue"

$TOKEN   = "${token}"
$API_URL = "${apiUrl}"

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

# On SessionStart: sync config file to Conduit + apply any pending update from dashboard
if ($event -eq "SessionStart") {
  $settingsPath = "$env:USERPROFILE\\.claude\\settings.json"
  if (Test-Path $settingsPath) {
    try {
      $configRaw = Get-Content $settingsPath -Raw
      $configEscaped = $configRaw | ConvertTo-Json -Compress
      $isoNow2 = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
      $ts2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $configPayload = '{"event":"config.sync","timestamp":"' + $isoNow2 + '","sessionId":"conduit-config","data":{"agentType":"claude-code","content":' + $configEscaped + '}}'
      $msgBytes2 = [System.Text.Encoding]::UTF8.GetBytes("$ts2.$configPayload")
      $hmac2 = New-Object System.Security.Cryptography.HMACSHA256
      $hmac2.Key = $keyBytes
      $sig2 = ($hmac2.ComputeHash($msgBytes2) | ForEach-Object { $_.ToString("x2") }) -join ""
       Invoke-RestMethod -Method Post -Uri "$API_URL/hooks" \`
         -Headers @{ "Authorization" = "Bearer $TOKEN"; "X-Conduit-Timestamp" = "$ts2"; "X-Conduit-Signature" = "sha256=$sig2" } \`
         -ContentType "application/json" -Body $configPayload | Out-Null
    } catch { }
  }

  # Check for pending config update from dashboard
  try {
     $pending = Invoke-RestMethod -Uri "$API_URL/config/pending" \`
      -Headers @{ "Authorization" = "Bearer $TOKEN" }
    $pendingContent = $pending.data.content
    if ($pendingContent) {
      New-Item -ItemType Directory -Force -Path (Split-Path $settingsPath) | Out-Null
      Set-Content -Path $settingsPath -Value $pendingContent -Encoding UTF8
       Invoke-RestMethod -Method Post -Uri "$API_URL/config/ack" \`
        -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
        -ContentType "application/json" -Body '{}' | Out-Null
    }
  } catch { }
}
`;
}

function generateInstallSh(token: string, apiUrl: string, _appUrl: string): string {
  const helper = generateBashScript(token, apiUrl);
  // base64-encode the helper so we can write it without a heredoc (no stdin dependency)
  const helperB64 = Buffer.from(helper, 'utf-8').toString('base64');

  // The settings-merge python script — also base64 to avoid heredoc stdin issues
  const pyScript = `import json, sys
helper, path = sys.argv[1], sys.argv[2]
try:
    cfg = json.loads(open(path).read())
except Exception:
    cfg = {}
hooks = cfg.setdefault("hooks", {})
entry = {"type": "command", "command": helper, "async": True}
for event in ("PostToolUse", "Stop", "SessionStart", "UserPromptSubmit"):
    lst = hooks.setdefault(event, [])
    block = {"matcher": "*", "hooks": [entry]} if event == "PostToolUse" else {"hooks": [entry]}
    if not any(any(h.get("command") == helper for h in b.get("hooks", [])) for b in lst):
        lst.append(block)
open(path, "w").write(json.dumps(cfg, indent=2) + "\\n")
print("  Updated  -> " + path)
`;
  const pyB64 = Buffer.from(pyScript, 'utf-8').toString('base64');

  return `#!/usr/bin/env bash
# Conduit Claude Code hook installer
set -euo pipefail

TOKEN="${token}"
API_URL="${apiUrl}"
HELPER="$HOME/.conduit-hook"
SETTINGS="$HOME/.claude/settings.json"

# ── Write helper (base64-encoded to avoid heredoc/stdin issues when piped) ─────
printf '%s' '${helperB64}' | base64 -d > "$HELPER"
chmod +x "$HELPER"
echo "  Saved helper -> $HELPER"

# ── Merge settings.json ────────────────────────────────────────────────────────
mkdir -p "$(dirname "$SETTINGS")"
printf '%s' '${pyB64}' | base64 -d | python3 - "$HELPER" "$SETTINGS"

# ── Register this instance with Conduit ────────────────────────────────────────
MACHINE_NAME=$(hostname 2>/dev/null || echo "linux-machine")
curl -sf -X POST "\${API_URL}/instances/register" \\
  -H "Authorization: Bearer \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"name\\":\\"$MACHINE_NAME\\",\\"type\\":\\"claude-code\\"}" > /dev/null && \\
  echo "  Registered instance: $MACHINE_NAME" || \\
  echo "  (Could not register instance — hooks will still work)"

${mcpSetupBash(token, apiUrl)}

echo ""
echo "Done! Conduit hooks are active for all future Claude Code sessions."
`;
}

function generateInstallPs1(token: string, apiUrl: string, _appUrl: string): string {
  const helper = generatePowerShellScript(token, apiUrl);

  return `# Conduit Claude Code hook installer
$ErrorActionPreference = "Stop"

$TOKEN      = "${token}"
$API_URL    = "${apiUrl}"
$HelperPath   = "$env:USERPROFILE\\.conduit-hook.ps1"
$SettingsPath = "$env:USERPROFILE\\.claude\\settings.json"

# ── Write helper ───────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Split-Path $HelperPath) | Out-Null
@'
${helper.replace(/'/g, "''")}
'@ | Set-Content -Path $HelperPath -Encoding UTF8
Write-Host "  Saved helper -> $HelperPath" -ForegroundColor Green

# ── Merge settings.json ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Split-Path $SettingsPath) | Out-Null
$cfg = @{}
if (Test-Path $SettingsPath) {
  try { $cfg = Get-Content $SettingsPath -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
}
if (-not $cfg) { $cfg = @{} }
if (-not $cfg.ContainsKey("hooks")) { $cfg["hooks"] = @{} }
$hookCmd   = "powershell -NonInteractive -ExecutionPolicy Bypass -File \`"$HelperPath\`""
$hookEntry = @{ type = "command"; command = $hookCmd; async = $true }
foreach ($event in @("PostToolUse", "Stop", "SessionStart", "UserPromptSubmit")) {
  if (-not $cfg["hooks"].ContainsKey($event)) { $cfg["hooks"][$event] = @() }
  $list = $cfg["hooks"][$event]
  # Remove any old conduit-hook entries (with or without ExecutionPolicy flag)
  $newList = @()
  foreach ($block in $list) {
    $innerHooks = if ($block -is [hashtable]) { $block["hooks"] } else { $block.hooks }
    $isConduitBlock = $false
    foreach ($h in $innerHooks) {
      $cmd = if ($h -is [hashtable]) { $h["command"] } else { $h.command }
      if ($cmd -like "*conduit-hook*") { $isConduitBlock = $true; break }
    }
    if (-not $isConduitBlock) { $newList += $block }
  }
  # Add fresh entry
  $block = if ($event -eq "PostToolUse") { @{ matcher = "*"; hooks = @($hookEntry) } } else { @{ hooks = @($hookEntry) } }
  $newList += $block
  $cfg["hooks"][$event] = $newList
}
$cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $SettingsPath -Encoding UTF8
Write-Host "  Updated  -> $SettingsPath" -ForegroundColor Green

# ── Register this instance with Conduit ───────────────────────────────────────
$machineName = $env:COMPUTERNAME
if (-not $machineName) { $machineName = "windows-machine" }
try {
  Invoke-RestMethod -Method Post -Uri "$API_URL/instances/register" \`
    -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
    -ContentType "application/json" \`
    -Body (ConvertTo-Json @{ name = $machineName; type = "claude-code" } -Compress) | Out-Null
  Write-Host "  Registered instance: $machineName" -ForegroundColor Green
} catch {
  Write-Host "  (Could not register instance — hooks will still work)" -ForegroundColor Yellow
}

${mcpSetupPs1(token, apiUrl)}

Write-Host ""
Write-Host "Done! Conduit hooks are active for all future Claude Code sessions." -ForegroundColor Cyan
`;
}

function generateOpenCodePlugin(token: string, apiUrl: string): string {
  return generateOpenCodePluginSource(token, apiUrl);
}

// ── Shared MCP setup snippet (bash) ───────────────────────────────────────────
// Installs @conduit-ai/mcp-server globally via npm and configures detected MCP clients.
function mcpSetupBash(token: string, apiUrl: string): string {
  return `
# ── MCP Server Setup ──────────────────────────────────────────────────────────
echo ""
echo "  Setting up Conduit MCP server..."

# Install @conduit-ai/mcp-server globally (requires npm/node)
if command -v npm &>/dev/null; then
  npm install -g @conduit-ai/mcp-server 2>/dev/null && \\
    echo "  Installed @conduit-ai/mcp-server globally" || \\
    echo "  (npm install failed — you can install manually: npm i -g @conduit-ai/mcp-server)"
else
  echo "  npm not found — skipping MCP server install."
  echo "  Install Node.js and run: npm i -g @conduit-ai/mcp-server"
fi

# Helper: inject MCP server config into a JSON file at the given jsonpath
# Usage: configure_mcp_client <config_file> <client_name>
configure_mcp_client() {
  local cfg_file="$1"
  local client_name="$2"

  if [[ ! -f "$cfg_file" ]]; then
    return
  fi

  # Check if conduit already configured
  if grep -q '"conduit"' "$cfg_file" 2>/dev/null; then
    echo "  MCP already configured in $client_name — skipping"
    return
  fi

  # Use python3 to safely merge JSON (available on macOS + most Linux)
  python3 -c "
import json, sys, os

cfg_file = '$cfg_file'
try:
    with open(cfg_file, 'r') as f:
        cfg = json.load(f)
except:
    cfg = {}

servers = cfg.setdefault('mcpServers', {})
servers['conduit'] = {
    'command': 'conduit-mcp',
    'type': 'local',
    'environment': {
        'CONDUIT_API_URL': '${apiUrl}',
        'CONDUIT_HOOK_TOKEN': '${token}'
    }
}

with open(cfg_file, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\\\\n')
" 2>/dev/null && echo "  Configured MCP server in $client_name" || true
}

# Detect and configure MCP clients
# OpenCode
OC_MCP="$HOME/.config/opencode/config.json"
if [[ -d "$HOME/.config/opencode" ]]; then
  [[ -f "$OC_MCP" ]] || echo '{}' > "$OC_MCP"
  configure_mcp_client "$OC_MCP" "OpenCode"
fi

# Claude Desktop
if [[ "$(uname)" == "Darwin" ]]; then
  CLAUDE_MCP="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
else
  CLAUDE_MCP="\${XDG_CONFIG_HOME:-$HOME/.config}/claude-desktop/claude_desktop_config.json"
fi
if [[ -f "$CLAUDE_MCP" ]]; then
  configure_mcp_client "$CLAUDE_MCP" "Claude Desktop"
fi

# Cursor
CURSOR_MCP="$HOME/.cursor/mcp.json"
if [[ -d "$HOME/.cursor" ]]; then
  [[ -f "$CURSOR_MCP" ]] || echo '{}' > "$CURSOR_MCP"
  configure_mcp_client "$CURSOR_MCP" "Cursor"
fi

# Windsurf
WINDSURF_MCP="$HOME/.codeium/windsurf/mcp_config.json"
if [[ -f "$WINDSURF_MCP" ]]; then
  configure_mcp_client "$WINDSURF_MCP" "Windsurf"
fi
`;
}

// ── Shared MCP setup snippet (PowerShell) ─────────────────────────────────────
function mcpSetupPs1(token: string, apiUrl: string): string {
  return `
# ── MCP Server Setup ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Setting up Conduit MCP server..." -ForegroundColor Cyan

# Install @conduit-ai/mcp-server globally
if (Get-Command npm -ErrorAction SilentlyContinue) {
  try {
    npm install -g @conduit-ai/mcp-server 2>$null | Out-Null
    Write-Host "  Installed @conduit-ai/mcp-server globally" -ForegroundColor Green
  } catch {
    Write-Host "  (npm install failed - run manually: npm i -g @conduit-ai/mcp-server)" -ForegroundColor Yellow
  }
} else {
  Write-Host "  npm not found - skipping MCP server install." -ForegroundColor Yellow
  Write-Host "  Install Node.js and run: npm i -g @conduit-ai/mcp-server" -ForegroundColor Yellow
}

# Helper: inject MCP server config into a JSON config file
function Configure-McpClient {
  param([string]$CfgFile, [string]$ClientName)

  if (-not (Test-Path $CfgFile)) { return }

  $content = Get-Content $CfgFile -Raw -ErrorAction SilentlyContinue
  if ($content -match '"conduit"') {
    Write-Host "  MCP already configured in $ClientName - skipping" -ForegroundColor Yellow
    return
  }

  try {
    $cfg = $content | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $cfg = [PSCustomObject]@{}
  }

  if (-not $cfg.mcpServers) {
    $cfg | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([PSCustomObject]@{}) -Force
  }

  $conduitEntry = [PSCustomObject]@{
    type = "local"
    command = "conduit-mcp"
    environment = [PSCustomObject]@{
      CONDUIT_API_URL = "${apiUrl}"
      CONDUIT_HOOK_TOKEN = "${token}"
    }
  }

  $cfg.mcpServers | Add-Member -NotePropertyName "conduit" -NotePropertyValue $conduitEntry -Force
  $cfg | ConvertTo-Json -Depth 10 | Set-Content $CfgFile -Encoding UTF8
  Write-Host "  Configured MCP server in $ClientName" -ForegroundColor Green
}

# Detect and configure MCP clients
# OpenCode
$OcMcp = "$env:USERPROFILE\\.config\\opencode\\config.json"
if (Test-Path "$env:USERPROFILE\\.config\\opencode") {
  if (-not (Test-Path $OcMcp)) { '{}' | Set-Content $OcMcp -Encoding UTF8 }
  Configure-McpClient -CfgFile $OcMcp -ClientName "OpenCode"
}

# Claude Desktop
$ClaudeMcp = "$env:APPDATA\\Claude\\claude_desktop_config.json"
if (Test-Path $ClaudeMcp) {
  Configure-McpClient -CfgFile $ClaudeMcp -ClientName "Claude Desktop"
}

# Cursor
$CursorMcp = "$env:USERPROFILE\\.cursor\\mcp.json"
if (Test-Path "$env:USERPROFILE\\.cursor") {
  if (-not (Test-Path $CursorMcp)) { '{}' | Set-Content $CursorMcp -Encoding UTF8 }
  Configure-McpClient -CfgFile $CursorMcp -ClientName "Cursor"
}

# Windsurf
$WindsurfMcp = "$env:USERPROFILE\\.codeium\\windsurf\\mcp_config.json"
if (Test-Path $WindsurfMcp) {
  Configure-McpClient -CfgFile $WindsurfMcp -ClientName "Windsurf"
}
`;
}

function generateOpenCodeInstallSh(token: string, apiUrl: string): string {
  const pluginContent = generateOpenCodePlugin(token, apiUrl);
  const pluginB64 = Buffer.from(pluginContent, 'utf-8').toString('base64');

  return `#!/usr/bin/env bash
# Conduit OpenCode plugin installer — auto-generated
# Writes a plugin to ~/.config/opencode/plugins/conduit.js that
# forwards events to Conduit on every opencode run. No tunnel needed.
set -euo pipefail

TOKEN="${token}"
API_URL="${apiUrl}"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
PLUGIN_FILE="$PLUGIN_DIR/conduit.js"
MACHINE_NAME=$(hostname 2>/dev/null || echo "opencode-machine")

echo ""
echo "  Conduit — OpenCode Plugin Installer"
echo "  ====================================="
echo ""

# ── Write plugin file ──────────────────────────────────────────────────────────
mkdir -p "$PLUGIN_DIR"
printf '%s' '${pluginB64}' | base64 -d > "$PLUGIN_FILE"
echo "  Saved plugin -> $PLUGIN_FILE"

# ── Register this instance with Conduit ────────────────────────────────────────
curl -sf -X POST "\${API_URL}/instances/register" \\
  -H "Authorization: Bearer \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"name\\":\\"$MACHINE_NAME\\",\\"type\\":\\"opencode\\"}" > /dev/null && \\
  echo "  Registered instance: $MACHINE_NAME" || \\
  echo "  (Could not register instance — plugin will still work)"
${mcpSetupBash(token, apiUrl)}
echo ""
echo "Done! Conduit plugin is active for all future OpenCode sessions."
`;
}

function generateOpenCodeUninstallSh(_token: string, apiUrl: string): string {
  return `#!/usr/bin/env bash
# Conduit OpenCode plugin uninstaller — auto-generated
set -euo pipefail

API_URL="${apiUrl}"
PLUGIN_FILE="$HOME/.config/opencode/plugins/conduit.js"

echo ""
echo "  Conduit — OpenCode Plugin Uninstaller"
echo "  ======================================="
echo ""

# ── Extract token from installed plugin (never served in this script) ─────────
TOKEN=""
if [[ -f "$PLUGIN_FILE" ]]; then
  TOKEN=$(grep -o 'const TOKEN = "[^"]*"' "$PLUGIN_FILE" 2>/dev/null | sed 's/const TOKEN = "\\(.*\\)"/\\1/' || true)
fi

if [[ -f "$PLUGIN_FILE" ]]; then
  rm -f "$PLUGIN_FILE"
  echo "  Removed plugin -> $PLUGIN_FILE"
else
  echo "  Plugin not found (already uninstalled?)"
fi

# ── Deregister this instance from Conduit ─────────────────────────────────────
if [[ -n "$TOKEN" ]]; then
  MACHINE_NAME=$(hostname 2>/dev/null || echo "opencode-machine")
  curl -sf -X POST "\${API_URL}/instances/deregister" \\
    -H "Authorization: Bearer \${TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"name\\":\\"$MACHINE_NAME\\",\\"type\\":\\"opencode\\"}" > /dev/null && \\
    echo "  Deregistered instance: $MACHINE_NAME" || \\
    echo "  (Could not deregister instance — it may have been removed already)"
else
  echo "  (No token found — skipping instance deregistration)"
fi

echo ""
echo "Done! Conduit plugin has been removed."
`;
}

function generateOpenCodeInstallPs1(token: string, apiUrl: string): string {
  const pluginContent = generateOpenCodePlugin(token, apiUrl);

  return `# Conduit OpenCode plugin installer — auto-generated
# Writes a plugin to ~/.config/opencode/plugins/conduit.js that
# forwards events to Conduit on every opencode run. No tunnel needed.
$ErrorActionPreference = "Stop"

$TOKEN       = "${token}"
$API_URL     = "${apiUrl}"
$PluginDir   = "$env:USERPROFILE\\.config\\opencode\\plugins"
$PluginFile  = "$PluginDir\\conduit.js"
$MachineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "opencode-machine" }

Write-Host ""
Write-Host "  Conduit - OpenCode Plugin Installer" -ForegroundColor Cyan
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host ""

# ── Write plugin file ──────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
@'
${pluginContent.replace(/'/g, "''")}
'@ | Set-Content -Path $PluginFile -Encoding UTF8
Write-Host "  Saved plugin -> $PluginFile" -ForegroundColor Green

# ── Register this instance with Conduit ───────────────────────────────────────
  try {
     Invoke-RestMethod -Method Post -Uri "$API_URL/instances/register" \`
       -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
       -ContentType "application/json" \`
       -Body (ConvertTo-Json @{ name = $MachineName; type = "opencode" } -Compress) | Out-Null
   Write-Host "  Registered instance: $MachineName" -ForegroundColor Green
 } catch {
   Write-Host "  (Could not register instance — plugin will still work)" -ForegroundColor Yellow
 }
${mcpSetupPs1(token, apiUrl)}
Write-Host ""
Write-Host "Done! Conduit plugin is active for all future OpenCode sessions." -ForegroundColor Cyan
`;
}

function generateOpenCodeUninstallPs1(_token: string, apiUrl: string): string {
  return `# Conduit OpenCode plugin uninstaller — auto-generated
$ErrorActionPreference = "SilentlyContinue"

$API_URL    = "${apiUrl}"
$PluginFile = "$env:USERPROFILE\\.config\\opencode\\plugins\\conduit.js"

Write-Host ""
Write-Host "  Conduit - OpenCode Plugin Uninstaller" -ForegroundColor Cyan
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host ""

# ── Extract token from installed plugin (never served in this script) ─────────
$TOKEN = ""
if (Test-Path $PluginFile) {
  $content = Get-Content $PluginFile -Raw -ErrorAction SilentlyContinue
  if ($content -match 'const TOKEN = "([^"]*)"') {
    $TOKEN = $Matches[1]
  }
}

if (Test-Path $PluginFile) {
  Remove-Item -Path $PluginFile -Force
  Write-Host "  Removed plugin -> $PluginFile" -ForegroundColor Green
} else {
  Write-Host "  Plugin not found (already uninstalled?)" -ForegroundColor Yellow
}

# ── Deregister this instance from Conduit ─────────────────────────────────────
if ($TOKEN) {
  $MachineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "opencode-machine" }
   try {
     Invoke-RestMethod -Method Post -Uri "$API_URL/instances/deregister" \`
       -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
       -ContentType "application/json" \`
       -Body (ConvertTo-Json @{ name = $MachineName; type = "opencode" } -Compress) | Out-Null
     Write-Host "  Deregistered instance: $MachineName" -ForegroundColor Green
   } catch {
     Write-Host "  (Could not deregister instance — it may have been removed already)" -ForegroundColor Yellow
   }
} else {
  Write-Host "  (No token found — skipping instance deregistration)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done! Conduit plugin has been removed." -ForegroundColor Cyan
`;
}

function generateClaudeUninstallSh(_token: string, apiUrl: string): string {
  return `#!/usr/bin/env bash
# Conduit Claude Code hook uninstaller — auto-generated
set -euo pipefail

API_URL="${apiUrl}"
HELPER="$HOME/.conduit-hook"
SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "  Conduit — Claude Code Hook Uninstaller"
echo "  ========================================"
echo ""

# ── Extract token from installed helper (never served in this script) ─────────
TOKEN=""
if [[ -f "$HELPER" ]]; then
  TOKEN=$(grep -o 'TOKEN="[^"]*"' "$HELPER" 2>/dev/null | head -1 | sed 's/TOKEN="\\(.*\\)"/\\1/' || true)
fi

# ── Remove helper binary ───────────────────────────────────────────────────────
if [[ -f "$HELPER" ]]; then
  rm -f "$HELPER"
  echo "  Removed helper -> $HELPER"
else
  echo "  Helper not found (already uninstalled?)"
fi

# ── Remove hooks from settings.json ───────────────────────────────────────────
if [[ -f "$SETTINGS" ]]; then
  python3 - "$HELPER" "$SETTINGS" << 'PYEOF'
import json, sys
helper, path = sys.argv[1], sys.argv[2]
try:
    cfg = json.loads(open(path).read())
except Exception:
    sys.exit(0)
hooks = cfg.get("hooks", {})
changed = False
for event, blocks in list(hooks.items()):
    new_blocks = []
    for block in blocks:
        inner = block.get("hooks", [])
        filtered = [h for h in inner if helper not in h.get("command", "")]
        if filtered:
            block = dict(block, hooks=filtered)
            new_blocks.append(block)
        else:
            changed = True
    hooks[event] = new_blocks
    if not new_blocks:
        del hooks[event]
        changed = True
cfg["hooks"] = hooks
if changed:
    open(path, "w").write(json.dumps(cfg, indent=2) + "\\n")
    print("  Updated  -> " + path)
else:
    print("  No Conduit hooks found in " + path)
PYEOF
else
  echo "  Settings file not found, skipping."
fi

# ── Deregister this instance from Conduit ─────────────────────────────────────
if [[ -n "$TOKEN" ]]; then
  MACHINE_NAME=$(hostname 2>/dev/null || echo "linux-machine")
   curl -sf -X POST "\${API_URL}/instances/deregister" \\
     -H "Authorization: Bearer \${TOKEN}" \\
     -H "Content-Type: application/json" \\
     -d "{\\"name\\":\\"$MACHINE_NAME\\",\\"type\\":\\"claude-code\\"}" > /dev/null && \\
    echo "  Deregistered instance: $MACHINE_NAME" || \\
    echo "  (Could not deregister instance — it may have been removed already)"
else
  echo "  (No token found — skipping instance deregistration)"
fi

echo ""
echo "Done! Conduit hooks have been removed."
`;
}

function generateClaudeUninstallPs1(_token: string, apiUrl: string): string {
  return `# Conduit Claude Code hook uninstaller — auto-generated
$ErrorActionPreference = "SilentlyContinue"

$API_URL      = "${apiUrl}"
$HelperPath   = "$env:USERPROFILE\\.conduit-hook.ps1"
$SettingsPath = "$env:USERPROFILE\\.claude\\settings.json"

Write-Host ""
Write-Host "  Conduit - Claude Code Hook Uninstaller" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# ── Extract token from installed helper (never served in this script) ─────────
$TOKEN = ""
if (Test-Path $HelperPath) {
  $helperContent = Get-Content $HelperPath -Raw -ErrorAction SilentlyContinue
  if ($helperContent -match '\\$TOKEN\\s*=\\s*"([^"]*)"') {
    $TOKEN = $Matches[1]
  }
}

# ── Remove helper ──────────────────────────────────────────────────────────────
if (Test-Path $HelperPath) {
  Remove-Item -Path $HelperPath -Force
  Write-Host "  Removed helper -> $HelperPath" -ForegroundColor Green
} else {
  Write-Host "  Helper not found (already uninstalled?)" -ForegroundColor Yellow
}

# ── Remove hooks from settings.json ───────────────────────────────────────────
if (Test-Path $SettingsPath) {
  try {
    $cfg = Get-Content $SettingsPath -Raw | ConvertFrom-Json -AsHashtable
    if (-not $cfg) { $cfg = @{} }
    $changed = $false
    if ($cfg.ContainsKey("hooks")) {
      foreach ($event in @($cfg["hooks"].Keys)) {
        $newList = @()
        foreach ($block in $cfg["hooks"][$event]) {
          $innerHooks = if ($block -is [hashtable]) { $block["hooks"] } else { $block.hooks }
          $filtered = @($innerHooks | Where-Object {
            $cmd = if ($_ -is [hashtable]) { $_["command"] } else { $_.command }
            $cmd -notlike "*conduit-hook*"
          })
          if ($filtered.Count -gt 0) {
            if ($block -is [hashtable]) { $block["hooks"] = $filtered } else { $block.hooks = $filtered }
            $newList += $block
          } else {
            $changed = $true
          }
        }
        $cfg["hooks"][$event] = $newList
        if ($newList.Count -eq 0) {
          $cfg["hooks"].Remove($event)
          $changed = $true
        }
      }
    }
    if ($changed) {
      $cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $SettingsPath -Encoding UTF8
      Write-Host "  Updated  -> $SettingsPath" -ForegroundColor Green
    } else {
      Write-Host "  No Conduit hooks found in $SettingsPath" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  Could not parse settings.json — skipping." -ForegroundColor Yellow
  }
} else {
  Write-Host "  Settings file not found, skipping." -ForegroundColor Yellow
}

# ── Deregister this instance from Conduit ─────────────────────────────────────
if ($TOKEN) {
  $MachineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "windows-machine" }
   try {
     Invoke-RestMethod -Method Post -Uri "$API_URL/instances/deregister" \`
       -Headers @{ "Authorization" = "Bearer $TOKEN" } \`
       -ContentType "application/json" \`
       -Body (ConvertTo-Json @{ name = $MachineName; type = "claude-code" } -Compress) | Out-Null
    Write-Host "  Deregistered instance: $MachineName" -ForegroundColor Green
  } catch {
    Write-Host "  (Could not deregister instance — it may have been removed already)" -ForegroundColor Yellow
  }
} else {
  Write-Host "  (No token found — skipping instance deregistration)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done! Conduit hooks have been removed." -ForegroundColor Cyan
`;
}

// ── Device flow rate limiting (per-IP) ────────────────────────────────────────


const deviceRateLimit = {
  max: 10,
  timeWindow: '1 minute',
};

const pollRateLimit = {
  max: 30,
  timeWindow: '1 minute',
};

export async function hookRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Device Flow endpoints ─────────────────────────────────────────────────

  // POST /hooks/install/device — public, rate-limited
  // Terminal bootstrap script calls this to start the device flow.
  // Returns { user_code, device_code, verification_uri, expires_in, interval }
  fastify.post(
    '/install/device',
    { config: { rateLimit: deviceRateLimit } },
    async (_request, reply) => {
      if (!config.hookToken) {
        return reply.code(500).send({ error: 'server_error', message: 'Hook token not configured' });
      }

      const db = fastify.db;

      // Prune expired sessions (mirrors old pruneExpiredDevices())
      db.query(`DELETE FROM device_flow_sessions WHERE expires_at < datetime('now')`).run();

      // Prevent DoS — cap pending (non-expired) devices
      const { count } = db.query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM device_flow_sessions WHERE expires_at >= datetime('now')`,
      ).get()!;
      if (count >= MAX_PENDING_DEVICES) {
        return reply.code(503).send({ error: 'server_busy', message: 'Too many pending activations. Try again later.' });
      }

      // Generate a collision-free user_code
      let userCode: string;
      let attempts = 0;
      do {
        userCode = generateUserCode();
        attempts++;
        if (attempts > 20) {
          return reply.code(503).send({ error: 'server_busy', message: 'Could not generate unique code. Try again.' });
        }
      } while (
        db.query<{ user_code: string }, [string]>(
          `SELECT user_code FROM device_flow_sessions WHERE user_code = ?`,
        ).get(userCode) !== null
      );

      const deviceCode = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + DEVICE_TTL_MS).toISOString().replace('T', ' ').replace('Z', '');

      db.query(
        `INSERT INTO device_flow_sessions (device_code, user_code, expires_at) VALUES (?, ?, ?)`,
      ).run(deviceCode, userCode, expiresAt);

      return reply.code(200).send({
        user_code: formatUserCode(userCode),
        device_code: deviceCode,
        verification_uri: `${config.appUrl}/app/activate`,
        expires_in: Math.floor(DEVICE_TTL_MS / 1000),
        interval: DEVICE_POLL_INTERVAL,
      });
    },
  );

  // POST /hooks/install/poll — public, rate-limited
  // Terminal polls this with { device_code } until approved or expired.
  // RFC 8628 §3.5 response codes.
  fastify.post(
    '/install/poll',
    { config: { rateLimit: pollRateLimit } },
    async (request, reply) => {
      const pollSchema = z.object({
        device_code: z.string().min(1, 'device_code is required'),
        shell: z.enum(['bash', 'powershell', 'bash-opencode', 'powershell-opencode']).optional(),
      });

      const parsed = pollSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: parsed.error.issues.map(i => i.message).join(', ') });
      }

      const { device_code, shell } = parsed.data;

      const db = fastify.db;

      interface DeviceRow {
        approved: number;
        expires_at: string;
        hook_token: string | null;
      }

      const row = db.query<DeviceRow, [string]>(
        `SELECT approved, expires_at, hook_token FROM device_flow_sessions WHERE device_code = ?`,
      ).get(device_code);

      if (!row) {
        return reply.code(400).send({ error: 'expired_token', message: 'Device code not found or expired' });
      }

      if (new Date(row.expires_at).getTime() < Date.now()) {
        db.query(`DELETE FROM device_flow_sessions WHERE device_code = ?`).run(device_code);
        return reply.code(400).send({ error: 'expired_token', message: 'Device code expired' });
      }

      if (!row.approved) {
        return reply.code(200).send({ error: 'authorization_pending' });
      }

      // Approved! Consume the device code (one-time use) and return the install script.
      db.query(`DELETE FROM device_flow_sessions WHERE device_code = ?`).run(device_code);

      if (!row.hook_token) {
        return reply.code(500).send({ error: 'server_error', message: 'Hook token not available for this device flow' });
      }

      const token = row.hook_token;

      // Detect which script to return based on the shell hint
      let script: string;
      if (shell === 'powershell') {
        script = generateInstallPs1(token, config.apiUrl, config.appUrl);
      } else if (shell === 'powershell-opencode') {
        script = generateOpenCodeInstallPs1(token, config.apiUrl);
      } else if (shell === 'bash-opencode') {
        script = generateOpenCodeInstallSh(token, config.apiUrl);
      } else {
        script = generateInstallSh(token, config.apiUrl, config.appUrl);
      }

      // SECURITY (CRIT-2): Sign the script with HMAC-SHA256 keyed on the device_code.
      // The terminal already holds the device_code (it got it from /install/device),
      // so it can verify the signature before piping to bash / Invoke-Expression.
      // This prevents a network MITM from substituting a malicious script payload,
      // even if the connection is not TLS-protected (e.g. localhost dev).
      const scriptHmac = computeHmacSignature(device_code, script);

      return reply.code(200).send({ script, script_hmac: scriptHmac });
    },
  );

  // POST /hooks/install/approve — authenticated + CSRF
  // Browser calls this when the user enters the user_code and clicks approve.
  fastify.post(
    '/install/approve',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const approveSchema = z.object({
        user_code: z.string().min(1, 'user_code is required'),
      });

      const parsed = approveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Bad Request', message: parsed.error.issues.map(i => i.message).join(', ') } as ApiError);
      }

      const normalized = normalizeUserCode(parsed.data.user_code);
      if (normalized.length !== USER_CODE_LENGTH) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid code format' } as ApiError);
      }

      const db = fastify.db;

      // Prune expired sessions
      db.query(`DELETE FROM device_flow_sessions WHERE expires_at < datetime('now')`).run();

      interface DeviceCodeRow { device_code: string; expires_at: string }
      const row = db.query<DeviceCodeRow, [string]>(
        `SELECT device_code, expires_at FROM device_flow_sessions WHERE user_code = ?`,
      ).get(normalized);

      if (!row) {
        return reply.code(404).send({ error: 'Not Found', message: 'Code not found or expired. Ask the user to run the install command again.' } as ApiError);
      }

      if (new Date(row.expires_at).getTime() < Date.now()) {
        db.query(`DELETE FROM device_flow_sessions WHERE device_code = ?`).run(row.device_code);
        return reply.code(404).send({ error: 'Not Found', message: 'Code expired. Ask the user to run the install command again.' } as ApiError);
      }

      // Get or create a per-user hook token for this user.
      // SECURITY (A-02): We never store the plaintext token in the DB.
      // For device flow we always regenerate so the terminal gets a fresh plaintext copy.
      // If a token already exists, we rotate it (delete + insert) to deliver a known-plaintext
      // value to the terminal without ever reading it back from storage.
      db.query(`DELETE FROM hook_tokens WHERE user_id = ?`).run(request.user!.id);
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), request.user!.id, tokenHash, tokenPrefix);

      // Mark the session as approved and store the plaintext hook token so /poll can retrieve it.
      db.query(
        `UPDATE device_flow_sessions SET approved = 1, user_id = ?, hook_token = ? WHERE device_code = ?`,
      ).run(request.user!.id, newToken, row.device_code);

      const response: ApiSuccess<{ approved: true }> = { data: { approved: true } };
      return reply.code(200).send(response);
    },
  );

  // GET /hooks/install-claude.sh — static bootstrap script (no params!)
  // This is the script piped from `curl -fsSL .../install-claude.sh | bash`
  // It runs the device flow interactively in the terminal.
  fastify.get('/install-claude.sh', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    const apiUrl = config.apiUrl;

    // SECURITY (CRIT-2): Refuse to serve the install script over plain HTTP in production.
    // The terminal will pipe the response directly to bash — MITM on HTTP lets an
    // attacker substitute any code. In production, TLS must be enforced at the
    // reverse-proxy level (nginx), and API_URL must start with https://.
    if (config.isProduction && !apiUrl.startsWith('https://')) {
      return reply.code(421).send({
        error: 'Insecure Transport',
        message: 'Install scripts may only be served over HTTPS. Set API_URL to an https:// address.',
      });
    }

    const script = `#!/usr/bin/env bash
# Conduit Claude Code hook installer — device flow bootstrap
# Usage: curl -fsSL ${apiUrl}/hooks/install-claude.sh | bash
set -euo pipefail

API_URL="${apiUrl}"

echo ""
echo "  Conduit — Claude Code Hook Installer"
echo "  ====================================="
echo ""

# Step 1: Request a device code
RESPONSE=$(curl -fsSX POST "\${API_URL}/hooks/install/device" \\
  -H "Content-Type: application/json" \\
  -d '{}')

# Parse response (portable — no jq dependency)
USER_CODE=$(printf '%s' "$RESPONSE" | grep -o '"user_code":"[^"]*"' | sed 's/"user_code":"\\([^"]*\\)"/\\1/')
DEVICE_CODE=$(printf '%s' "$RESPONSE" | grep -o '"device_code":"[^"]*"' | sed 's/"device_code":"\\([^"]*\\)"/\\1/')
VERIFY_URI=$(printf '%s' "$RESPONSE" | grep -o '"verification_uri":"[^"]*"' | sed 's/"verification_uri":"\\([^"]*\\)"/\\1/')
INTERVAL=$(printf '%s' "$RESPONSE" | grep -o '"interval":[0-9]*' | sed 's/"interval"://')
EXPIRES_IN=$(printf '%s' "$RESPONSE" | grep -o '"expires_in":[0-9]*' | sed 's/"expires_in"://')

if [[ -z "$USER_CODE" || -z "$DEVICE_CODE" ]]; then
  ERROR=$(printf '%s' "$RESPONSE" | grep -o '"message":"[^"]*"' | sed 's/"message":"\\([^"]*\\)"/\\1/')
  echo "  Error: \${ERROR:-Failed to start device flow. Is the Conduit API reachable?}"
  exit 1
fi

INTERVAL=\${INTERVAL:-5}
EXPIRES_IN=\${EXPIRES_IN:-300}

echo "  Open this URL in your browser:"
echo ""
echo "    $VERIFY_URI"
echo ""
echo "  Then enter this code:"
echo ""
echo "    $USER_CODE"
echo ""
echo "  Waiting for approval (expires in \${EXPIRES_IN}s)..."
echo ""

# Step 2: Poll until approved
ELAPSED=0
while [[ $ELAPSED -lt $EXPIRES_IN ]]; do
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))

   POLL=$(curl -fsSX POST "\${API_URL}/hooks/install/poll" \\
     -H "Content-Type: application/json" \\
     -d "{\\"device_code\\":\\"$DEVICE_CODE\\",\\"shell\\":\\"bash\\"}")

  # Check for script (success) — use python3 to safely decode JSON string
  if printf '%s' "$POLL" | grep -q '"script"'; then
    SCRIPT=$(printf '%s' "$POLL" | python3 -c "import json,sys; print(json.load(sys.stdin)['script'], end='')")
    SCRIPT_HMAC=$(printf '%s' "$POLL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('script_hmac',''), end='')")

    # SECURITY: Verify the HMAC-SHA256 signature of the script before executing it.
    # Key = device_code (known only to this terminal session and the server).
    # This prevents a MITM from substituting a malicious script payload.
    if [[ -n "$SCRIPT_HMAC" ]]; then
      EXPECTED_HMAC=$(printf '%s' "$SCRIPT" | openssl dgst -sha256 -hmac "$DEVICE_CODE" | awk '{print $NF}')
      if [[ "$SCRIPT_HMAC" != "$EXPECTED_HMAC" ]]; then
        echo "  ⚠️  SECURITY ERROR: Script signature verification failed!"
        echo "  The install script may have been tampered with in transit."
        echo "  Aborting installation. Please retry over a secure connection."
        exit 1
      fi
    else
      echo "  Warning: Server did not return a script signature. Proceeding without verification."
    fi

    echo "  Approved! Installing..."
    echo ""
    printf '%s' "$SCRIPT" | bash
    exit 0
  fi

  # Check for errors
  ERROR_TYPE=$(printf '%s' "$POLL" | grep -o '"error":"[^"]*"' | sed 's/"error":"\\([^"]*\\)"/\\1/')

  case "$ERROR_TYPE" in
    authorization_pending)
      # Still waiting — continue polling
      ;;
    slow_down)
      INTERVAL=$((INTERVAL + 5))
      ;;
    expired_token)
      echo "  Code expired. Please run the command again."
      exit 1
      ;;
    access_denied)
      echo "  Access denied."
      exit 1
      ;;
    *)
      echo "  Unexpected error: $ERROR_TYPE"
      exit 1
      ;;
  esac
done

echo "  Timed out waiting for approval. Please run the command again."
exit 1
`;

    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="install-claude.sh"')
      .header('Cache-Control', 'no-store')
      .send(script);
  });

  // GET /hooks/install-claude.ps1 — static bootstrap script (no params!)
  // This is the script piped from `iwr -useb .../install-claude.ps1 | iex`
  fastify.get('/install-claude.ps1', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    const apiUrl = config.apiUrl;

    // SECURITY (CRIT-2): Refuse to serve the install script over plain HTTP in production.
    if (config.isProduction && !apiUrl.startsWith('https://')) {
      return reply.code(421).send({
        error: 'Insecure Transport',
        message: 'Install scripts may only be served over HTTPS. Set API_URL to an https:// address.',
      });
    }

     const script = `# Conduit Claude Code hook installer — device flow bootstrap
# Usage: iwr -useb ${apiUrl}/hooks/install-claude.ps1 | iex
$ErrorActionPreference = "Stop"

$API_URL = "${apiUrl}"


Write-Host ""
Write-Host "  Conduit - Claude Code Hook Installer" -ForegroundColor Cyan
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Request a device code
try {
   $response = Invoke-RestMethod -Method Post -Uri "$API_URL/hooks/install/device" \`
     -ContentType "application/json" -Body '{}'
 } catch {
   Write-Host "  Error: Failed to start device flow. Is the Conduit API reachable?" -ForegroundColor Red
   exit 1
 }

$userCode   = $response.user_code
$deviceCode = $response.device_code
$verifyUri  = $response.verification_uri
$interval   = if ($response.interval) { $response.interval } else { 5 }
$expiresIn  = if ($response.expires_in) { $response.expires_in } else { 300 }

if (-not $userCode -or -not $deviceCode) {
  $msg = if ($response.message) { $response.message } else { "Unknown error" }
  Write-Host "  Error: $msg" -ForegroundColor Red
  exit 1
}

Write-Host "  Open this URL in your browser:"
Write-Host ""
Write-Host "    $verifyUri" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Then enter this code:"
Write-Host ""
Write-Host "    $userCode" -ForegroundColor Green
Write-Host ""
Write-Host "  Waiting for approval (expires in \${expiresIn}s)..."
Write-Host ""

# Step 2: Poll until approved
$elapsed = 0
while ($elapsed -lt $expiresIn) {
  Start-Sleep -Seconds $interval
  $elapsed += $interval

  try {
     $poll = Invoke-RestMethod -Method Post -Uri "$API_URL/hooks/install/poll" \`
       -ContentType "application/json" \`
       -Body (ConvertTo-Json @{ device_code = $deviceCode; shell = "powershell" } -Compress)
  } catch {
    continue
  }

  if ($poll.script) {
    $script     = $poll.script
    $scriptHmac = $poll.script_hmac

    # SECURITY: Verify the HMAC-SHA256 signature of the script before executing it.
    # Key = device_code (known only to this terminal session and the server).
    if ($scriptHmac) {
      $keyBytes    = [System.Text.Encoding]::UTF8.GetBytes($deviceCode)
      $dataBytes   = [System.Text.Encoding]::UTF8.GetBytes($script)
      $hmac        = New-Object System.Security.Cryptography.HMACSHA256
      $hmac.Key    = $keyBytes
      $hashBytes   = $hmac.ComputeHash($dataBytes)
      $expectedHmac = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""
      if ($expectedHmac -ne $scriptHmac) {
        Write-Host "  SECURITY ERROR: Script signature verification failed!" -ForegroundColor Red
        Write-Host "  The install script may have been tampered with in transit." -ForegroundColor Red
        Write-Host "  Aborting installation. Please retry over a secure connection." -ForegroundColor Red
        exit 1
      }
    } else {
      Write-Host "  Warning: Server did not return a script signature. Proceeding without verification." -ForegroundColor Yellow
    }

    Write-Host "  Approved! Installing..." -ForegroundColor Green
    Write-Host ""
    Invoke-Expression $script
    exit 0
  }

  switch ($poll.error) {
    "authorization_pending" { <# keep polling #> }
    "slow_down"    { $interval += 5 }
    "expired_token" {
      Write-Host "  Code expired. Please run the command again." -ForegroundColor Red
      exit 1
    }
    "access_denied" {
      Write-Host "  Access denied." -ForegroundColor Red
      exit 1
    }
    default {
      Write-Host "  Unexpected error: $($poll.error)" -ForegroundColor Red
      exit 1
    }
  }
}

Write-Host "  Timed out waiting for approval. Please run the command again." -ForegroundColor Red
exit 1
`;

    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="install-claude.ps1"')
      .header('Cache-Control', 'no-store')
      .send(script);
  });

  // GET /hooks/install-opencode.sh — bootstrap for OpenCode (bash device flow)
  // Usage: curl -fsSL .../install-opencode.sh | bash
  fastify.get('/install-opencode.sh', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    const apiUrl = config.apiUrl;

    // SECURITY (CRIT-2): Refuse to serve the install script over plain HTTP in production.
    if (config.isProduction && !apiUrl.startsWith('https://')) {
      return reply.code(421).send({
        error: 'Insecure Transport',
        message: 'Install scripts may only be served over HTTPS. Set API_URL to an https:// address.',
      });
    }

    const script = `#!/usr/bin/env bash
# Conduit OpenCode installer — device flow bootstrap
# Usage: curl -fsSL ${apiUrl}/hooks/install-opencode.sh | bash
set -euo pipefail

API_URL="${apiUrl}"

echo ""
echo "  Conduit — OpenCode Installer"
echo "  ============================="
echo ""

# Step 1: Request a device code
RESPONSE=$(curl -fsSX POST "\${API_URL}/hooks/install/device" \\
  -H "Content-Type: application/json" \\
  -d '{}')

USER_CODE=$(printf '%s' "$RESPONSE" | grep -o '"user_code":"[^"]*"' | sed 's/"user_code":"\\([^"]*\\)"/\\1/')
DEVICE_CODE=$(printf '%s' "$RESPONSE" | grep -o '"device_code":"[^"]*"' | sed 's/"device_code":"\\([^"]*\\)"/\\1/')
VERIFY_URI=$(printf '%s' "$RESPONSE" | grep -o '"verification_uri":"[^"]*"' | sed 's/"verification_uri":"\\([^"]*\\)"/\\1/')
INTERVAL=$(printf '%s' "$RESPONSE" | grep -o '"interval":[0-9]*' | sed 's/"interval"://')
EXPIRES_IN=$(printf '%s' "$RESPONSE" | grep -o '"expires_in":[0-9]*' | sed 's/"expires_in"://')

if [[ -z "$USER_CODE" || -z "$DEVICE_CODE" ]]; then
  ERROR=$(printf '%s' "$RESPONSE" | grep -o '"message":"[^"]*"' | sed 's/"message":"\\([^"]*\\)"/\\1/')
  echo "  Error: \${ERROR:-Failed to start device flow. Is the Conduit API reachable?}"
  exit 1
fi

INTERVAL=\${INTERVAL:-5}
EXPIRES_IN=\${EXPIRES_IN:-300}

echo "  Open this URL in your browser:"
echo ""
echo "    $VERIFY_URI"
echo ""
echo "  Then enter this code:"
echo ""
echo "    $USER_CODE"
echo ""
echo "  Waiting for approval (expires in \${EXPIRES_IN}s)..."
echo ""

ELAPSED=0
while [[ $ELAPSED -lt $EXPIRES_IN ]]; do
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))

   POLL=$(curl -fsSX POST "\${API_URL}/hooks/install/poll" \\
     -H "Content-Type: application/json" \\
     -d "{\\"device_code\\":\\"$DEVICE_CODE\\",\\"shell\\":\\"bash-opencode\\"}")

  if printf '%s' "$POLL" | grep -q '"script"'; then
    SCRIPT=$(printf '%s' "$POLL" | python3 -c "import json,sys; print(json.load(sys.stdin)['script'], end='')")
    SCRIPT_HMAC=$(printf '%s' "$POLL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('script_hmac',''), end='')")

    # SECURITY: Verify the HMAC-SHA256 signature of the script before executing it.
    if [[ -n "$SCRIPT_HMAC" ]]; then
      EXPECTED_HMAC=$(printf '%s' "$SCRIPT" | openssl dgst -sha256 -hmac "$DEVICE_CODE" | awk '{print $NF}')
      if [[ "$SCRIPT_HMAC" != "$EXPECTED_HMAC" ]]; then
        echo "  ⚠️  SECURITY ERROR: Script signature verification failed!"
        echo "  The install script may have been tampered with in transit."
        echo "  Aborting installation. Please retry over a secure connection."
        exit 1
      fi
    else
      echo "  Warning: Server did not return a script signature. Proceeding without verification."
    fi

    echo "  Approved! Starting OpenCode..."
    echo ""
    printf '%s' "$SCRIPT" | bash
    exit 0
  fi

  ERROR_TYPE=$(printf '%s' "$POLL" | grep -o '"error":"[^"]*"' | sed 's/"error":"\\([^"]*\\)"/\\1/')

  case "$ERROR_TYPE" in
    authorization_pending) ;;
    slow_down) INTERVAL=$((INTERVAL + 5)) ;;
    expired_token) echo "  Code expired. Please run the command again."; exit 1 ;;
    access_denied) echo "  Access denied."; exit 1 ;;
    *) echo "  Unexpected error: $ERROR_TYPE"; exit 1 ;;
  esac
done

echo "  Timed out waiting for approval. Please run the command again."
exit 1
`;

    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="install-opencode.sh"')
      .header('Cache-Control', 'no-store')
      .send(script);
  });

  // GET /hooks/install-opencode.ps1 — bootstrap for OpenCode (PowerShell device flow)
  // Usage: iwr -useb .../install-opencode.ps1 | iex
  fastify.get('/install-opencode.ps1', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    const apiUrl = config.apiUrl;

    // SECURITY (CRIT-2): Refuse to serve the install script over plain HTTP in production.
    if (config.isProduction && !apiUrl.startsWith('https://')) {
      return reply.code(421).send({
        error: 'Insecure Transport',
        message: 'Install scripts may only be served over HTTPS. Set API_URL to an https:// address.',
      });
    }

     const script = `# Conduit OpenCode installer — device flow bootstrap
# Usage: iwr -useb ${apiUrl}/hooks/install-opencode.ps1 | iex
$ErrorActionPreference = "Stop"

$API_URL = "${apiUrl}"

Write-Host ""
Write-Host "  Conduit - OpenCode Installer" -ForegroundColor Cyan
Write-Host "  =============================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Request a device code
try {
   $response = Invoke-RestMethod -Method Post -Uri "$API_URL/hooks/install/device" \`
     -ContentType "application/json" -Body '{}'
 } catch {
   Write-Host "  Error: Failed to start device flow. Is the Conduit API reachable?" -ForegroundColor Red
   exit 1
 }

$userCode   = $response.user_code
$deviceCode = $response.device_code
$verifyUri  = $response.verification_uri
$interval   = if ($response.interval) { $response.interval } else { 5 }
$expiresIn  = if ($response.expires_in) { $response.expires_in } else { 300 }

if (-not $userCode -or -not $deviceCode) {
  $msg = if ($response.message) { $response.message } else { "Unknown error" }
  Write-Host "  Error: $msg" -ForegroundColor Red
  exit 1
}

Write-Host "  Open this URL in your browser:"
Write-Host ""
Write-Host "    $verifyUri" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Then enter this code:"
Write-Host ""
Write-Host "    $userCode" -ForegroundColor Green
Write-Host ""
Write-Host "  Waiting for approval (expires in \${expiresIn}s)..."
Write-Host ""

$elapsed = 0
while ($elapsed -lt $expiresIn) {
  Start-Sleep -Seconds $interval
  $elapsed += $interval

  try {
     $poll = Invoke-RestMethod -Method Post -Uri "$API_URL/hooks/install/poll" \`
       -ContentType "application/json" \`
       -Body (ConvertTo-Json @{ device_code = $deviceCode; shell = "powershell-opencode" } -Compress)
  } catch {
    continue
  }

  if ($poll.script) {
    $script     = $poll.script
    $scriptHmac = $poll.script_hmac

    # SECURITY: Verify the HMAC-SHA256 signature of the script before executing it.
    if ($scriptHmac) {
      $keyBytes    = [System.Text.Encoding]::UTF8.GetBytes($deviceCode)
      $dataBytes   = [System.Text.Encoding]::UTF8.GetBytes($script)
      $hmac        = New-Object System.Security.Cryptography.HMACSHA256
      $hmac.Key    = $keyBytes
      $hashBytes   = $hmac.ComputeHash($dataBytes)
      $expectedHmac = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""
      if ($expectedHmac -ne $scriptHmac) {
        Write-Host "  SECURITY ERROR: Script signature verification failed!" -ForegroundColor Red
        Write-Host "  The install script may have been tampered with in transit." -ForegroundColor Red
        Write-Host "  Aborting installation. Please retry over a secure connection." -ForegroundColor Red
        exit 1
      }
    } else {
      Write-Host "  Warning: Server did not return a script signature. Proceeding without verification." -ForegroundColor Yellow
    }

    Write-Host "  Approved! Starting OpenCode..." -ForegroundColor Green
    Write-Host ""
    Invoke-Expression $script
    exit 0
  }

  switch ($poll.error) {
    "authorization_pending" { <# keep polling #> }
    "slow_down"    { $interval += 5 }
    "expired_token" {
      Write-Host "  Code expired. Please run the command again." -ForegroundColor Red
      exit 1
    }
    "access_denied" {
      Write-Host "  Access denied." -ForegroundColor Red
      exit 1
    }
    default {
      Write-Host "  Unexpected error: $($poll.error)" -ForegroundColor Red
      exit 1
    }
  }
}

Write-Host "  Timed out waiting for approval. Please run the command again." -ForegroundColor Red
exit 1
`;

    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="install-opencode.ps1"')
      .header('Cache-Control', 'no-store')
      .send(script);
  });

  // GET /hooks/uninstall-claude.sh — removes helper + settings.json hooks
  fastify.get('/uninstall-claude.sh', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="uninstall-claude.sh"')
      .header('Cache-Control', 'no-store')
      .send(generateClaudeUninstallSh(config.hookToken ?? '', config.apiUrl));
  });

  // GET /hooks/uninstall-claude.ps1 — removes helper + settings.json hooks (Windows)
  fastify.get('/uninstall-claude.ps1', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="uninstall-claude.ps1"')
      .header('Cache-Control', 'no-store')
      .send(generateClaudeUninstallPs1(config.hookToken ?? '', config.apiUrl));
  });

  // GET /hooks/uninstall-opencode.sh — removes OpenCode plugin (Linux/macOS)
  fastify.get('/uninstall-opencode.sh', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="uninstall-opencode.sh"')
      .header('Cache-Control', 'no-store')
      .send(generateOpenCodeUninstallSh(config.hookToken ?? '', config.apiUrl));
  });

  // GET /hooks/uninstall-opencode.ps1 — removes OpenCode plugin (Windows)
  fastify.get('/uninstall-opencode.ps1', { config: { rateLimit: apiReadRateLimit } }, async (_request, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="uninstall-opencode.ps1"')
      .header('Cache-Control', 'no-store')
      .send(generateOpenCodeUninstallPs1(config.hookToken ?? '', config.apiUrl));
  });

  // POST /hooks — webhook receiver (unchanged)
  fastify.post(
    '/',
    {
      config: { rateLimit: webhookRateLimit },
      bodyLimit: 1_048_576, // 1 MB — webhook payloads should be small JSON
    },
    async (request, reply) => {
      // 1. Resolve the hook token to a user
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid or missing authorization token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const hookUserId = resolution.userId;

      // Extract the raw Bearer token for HMAC verification
      const rawBearerToken = extractBearerToken(request);
      if (!rawBearerToken) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing Bearer token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // For per-user tokens, look up the raw token from the DB for HMAC.
      // For legacy global tokens, use config.hookToken.
      let hmacSecret: string;
      if (hookUserId) {
        // Per-user token — the raw Bearer IS the HMAC secret
        hmacSecret = rawBearerToken;
      } else {
        // Legacy global token
        hmacSecret = config.hookToken;
      }

      // 2. Verify timestamp (±5 min replay window)
      const timestampHeader = request.headers['x-conduit-timestamp'] as string | undefined;
      if (!timestampHeader) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing X-Conduit-Timestamp header',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const timestamp = parseInt(timestampHeader, 10);
      if (isNaN(timestamp)) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid timestamp format',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const now = Date.now();
      const diff = Math.abs(now - timestamp);
      if (diff > REPLAY_WINDOW_MS) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Request timestamp outside acceptable window',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // 3. Verify HMAC signature
      const signatureHeader = request.headers['x-conduit-signature'] as string | undefined;
      if (!signatureHeader) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing X-Conduit-Signature header',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // SECURITY NOTE: We re-serialize the parsed body with JSON.stringify() to compute
      // the HMAC. This is safe because all clients (bash helper, PowerShell helper, JS
      // plugin) also use JSON.stringify() / ConvertTo-Json -Compress to produce the
      // signing payload. Both sides use deterministic JSON serialization, so the
      // signatures match. If raw body preservation were needed (e.g. for third-party
      // clients with different serializers), use Fastify's rawBody option instead.
      const rawBody = JSON.stringify(request.body);
      const signingData = `${timestampHeader}.${rawBody}`;

      const signature = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice(7)
        : signatureHeader;

      if (!verifyHmacSignature(hmacSecret, signingData, signature)) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid signature',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // 4. Validate payload
      const parsed = hookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const payload = parsed.data as HookPayload;
      const eventId = randomUUID();
      const db = fastify.db;

      // 5. Resolve instance_id — use instance type that matches the event source
      const CONDUIT_INTERNAL_EVENTS = new Set(['config.sync', 'models.sync']);
      const eventName = payload.event as string;
      const isConduitInternal = CONDUIT_INTERNAL_EVENTS.has(eventName);
      const isOpenCodeEvent = !isConduitInternal && eventName.includes('.');
      // For conduit-internal events (config.sync, models.sync), use the agentType field
      // from the payload to route to the correct instance. Both the OpenCode plugin and the
      // Claude Code MCP/bash helper now stamp this field; fall back to 'claude-code' for
      // older clients that predate this field.
      const instanceType = isConduitInternal
        ? ((payload.data as Record<string, unknown>)['agentType'] === 'opencode' ? 'opencode' : 'claude-code')
        : (isOpenCodeEvent ? 'opencode' : 'claude-code');

      // Scope to the user's instances when using a per-user token.
      // Resolution order (most specific → least specific):
      //   1. If the event carries a sessionId, find the instance that last sent
      //      events for that session — this ties the config.sync to the exact
      //      machine that owns the session, even when multiple Claude Code
      //      instances are registered for the same user.
      //   2. Fall back to the most-recently-seen instance of the correct type.
      let instanceRow: { id: string } | undefined;
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;

      if (hookUserId) {
        // 1. Session-scoped lookup (avoids multi-machine collision)
        if (sessionId && sessionId !== 'conduit-config' && sessionId !== 'conduit-models' && sessionId !== 'unknown') {
          instanceRow = db.query(`
            SELECT instance_id as id FROM hook_events
            WHERE session_id = ?
              AND instance_id IN (SELECT id FROM instances WHERE type = ? AND user_id = ?)
            ORDER BY received_at DESC LIMIT 1
          `).get(sessionId, instanceType, hookUserId) as { id: string } | undefined;
        }
        // 2. Fallback: most-recently-seen instance of the correct type
        if (!instanceRow) {
          instanceRow = db.query(`
            SELECT id FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1
          `).get(instanceType, hookUserId) as { id: string } | undefined;
        }
      } else {
        // Legacy global token: match any instance (backward compat)
        if (sessionId && sessionId !== 'conduit-config' && sessionId !== 'conduit-models' && sessionId !== 'unknown') {
          instanceRow = db.query(`
            SELECT instance_id as id FROM hook_events
            WHERE session_id = ?
              AND instance_id IN (SELECT id FROM instances WHERE type = ?)
            ORDER BY received_at DESC LIMIT 1
          `).get(sessionId, instanceType) as { id: string } | undefined;
        }
        if (!instanceRow) {
          instanceRow = db.query(`
            SELECT id FROM instances WHERE type = ? ORDER BY last_seen DESC LIMIT 1
          `).get(instanceType) as { id: string } | undefined;
        }
      }

      // Auto-create instance if none registered yet (e.g. first config.sync before registration)
      if (!instanceRow) {
        const newInstanceId = randomUUID();
        db.query(`
          INSERT INTO instances (id, name, type, user_id, status, last_seen, created_at)
          VALUES (?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
        `).run(newInstanceId, instanceType === 'opencode' ? 'OpenCode' : 'Claude Code', instanceType, hookUserId);
        instanceRow = { id: newInstanceId };
      }

      const instanceId = instanceRow.id;

      // 5b. Update instance last_seen / status immediately (don't wait for health-check cycle).
      // Emit instance.updated SSE only when the status actually changes to avoid
      // flooding the bus with every hook event.
      const prevInstance = db.query(`SELECT status FROM instances WHERE id = ?`).get(instanceId) as { status: string } | undefined;
      db.query(`UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ?`).run(instanceId);
      if (prevInstance?.status !== 'connected') {
        emitInstanceUpdated(db, instanceId);
      }

      // 5c. Store event
      db.query(`
        INSERT INTO hook_events (id, instance_id, event_type, session_id, payload, received_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(eventId, instanceId, payload.event, payload.sessionId, JSON.stringify(payload.data));

      // 5c-bis. Update pre-aggregated metrics counters
      if (hookUserId) {
        const aggregator = fastify.metricsAggregator;
        const eventType = payload.event as string;
        const data = payload.data as Record<string, unknown>;

        // Message tracking — OpenCode: message.updated; Claude Code: UserPromptSubmit (one per user turn)
        if (eventType === 'message.updated') {
          const info = data['info'] as Record<string, unknown> | undefined;
          const msgId = (info?.['id'] as string) ?? (data['id'] as string) ?? eventId;
          aggregator.trackMessage(hookUserId, instanceId, msgId);

          // Token/cost tracking — only for assistant messages
          const role = info?.['role'] as string | undefined;
          if (role === 'assistant') {
            const tokensObj = info?.['tokens'] as Record<string, unknown> | undefined;
            const cacheObj = tokensObj?.['cache'] as Record<string, number> | undefined;
            const input = (tokensObj?.['input'] as number) ?? 0;
            const output = (tokensObj?.['output'] as number) ?? 0;
            const reasoning = (tokensObj?.['reasoning'] as number) ?? 0;
            const totalTokens = input + output + reasoning;
            if (totalTokens > 0) {
              const modelId = (info?.['modelID'] as string) ?? '';
              const provider = (info?.['providerID'] as string) ?? '';
              // Compute cost server-side — OpenCode always reports cost: 0
              pricingService.computeCost(modelId, provider, {
                input,
                output,
                reasoning,
                cache: { read: cacheObj?.['read'], write: cacheObj?.['write'] },
              }).then((cost) => {
                aggregator.trackTokensAndCost(hookUserId, instanceId, msgId, totalTokens, cost);
              }).catch(() => {
                aggregator.trackTokensAndCost(hookUserId, instanceId, msgId, totalTokens, 0);
              });
            }
          }
        }

        // Message tracking — Claude Code: UserPromptSubmit fires once per user prompt
        if (eventType === 'UserPromptSubmit') {
          aggregator.trackMessage(hookUserId, instanceId, eventId);
        }

        // Tool call tracking — OpenCode: message.part.updated with part.type="tool".
        // Only count on the first appearance (status="pending") to avoid a dedup
        // SELECT on every streaming chunk for the same call.
        if (eventType === 'message.part.updated') {
          const part = data['part'] as Record<string, unknown> | undefined;
          if (part?.['type'] === 'tool') {
            const state = part['state'] as Record<string, unknown> | undefined;
            if (state?.['status'] === 'pending') {
              const callId = (part['callID'] as string) ?? eventId;
              aggregator.trackToolCall(hookUserId, instanceId, callId);
            }
          }
        }

        // Tool call tracking — Claude Code: PostToolUse (fired after each tool)
        // PreToolUse is skipped to avoid double-counting (PostToolUse fires for every completed call)
        // tool.execute.after is skipped — message.part.updated status=pending already covers OpenCode
        if (eventType === 'PostToolUse') {
          aggregator.trackToolCall(hookUserId, instanceId, eventId);
        }
      }

      // 5c-ter. Broadcast to all connected SSE clients via the event bus.
      // Map Claude Code hook event names (e.g. "SessionStart") to the canonical
      // SSE event types the frontend listeners expect (e.g. "session.created").
      // The original event name is preserved in the data payload for traceability.
      const sseEventType = toSSEEventType(payload.event);
      if (sseEventType !== null) {
        eventBus.emit(sseEventType, {
          id: eventId,
          instanceId,
          sessionId: payload.sessionId,
          event: payload.event,
          data: payload.data,
          timestamp: payload.timestamp,
        });
      }

      // 5d. Handle config.sync — upsert the config snapshot for this instance
      if (payload.event === 'config.sync') {
        const configContent = typeof payload.data['content'] === 'string'
          ? payload.data['content']
          : JSON.stringify(payload.data['content'] ?? payload.data);
        db.query(`
          INSERT INTO config_snapshots (instance_id, agent_type, content, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(instance_id) DO UPDATE SET
            content    = excluded.content,
            agent_type = excluded.agent_type,
            updated_at = datetime('now')
        `).run(instanceId, instanceType, configContent);
      }

      // 5e. Handle models.sync — replace model list for this instance
      if (payload.event === 'models.sync') {
        const rawModels = payload.data['models'];
        if (Array.isArray(rawModels)) {
          const upsertModel = db.prepare(`
            INSERT INTO instance_models (instance_id, provider_id, model_id, model_name, synced_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(instance_id, provider_id, model_id) DO UPDATE SET
              model_name = excluded.model_name,
              synced_at  = datetime('now')
          `);
          // Replace all models for this instance in a transaction
          db.transaction(() => {
            db.query(`DELETE FROM instance_models WHERE instance_id = ?`).run(instanceId);
            for (const m of rawModels) {
              if (
                m && typeof m === 'object' &&
                typeof (m as Record<string, unknown>)['providerId'] === 'string' &&
                typeof (m as Record<string, unknown>)['modelId'] === 'string' &&
                typeof (m as Record<string, unknown>)['modelName'] === 'string'
              ) {
                const model = m as { providerId: string; modelId: string; modelName: string };
                upsertModel.run(instanceId, model.providerId, model.modelId, model.modelName);
              }
            }
          })();
        }
      }

      const response: HookResponse = {
        received: true,
        id: eventId,
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/batch — receive multiple hook events in a single request.
  // Accepts an array of up to 500 events, processes them all in one SQLite transaction.
  // Auth and HMAC signing are identical to POST /hooks — the signature covers the
  // entire batch body: `ts.JSON.stringify({ events: [...] })`.
  // This endpoint is the target of the OpenCode plugin's 1-second buffer flush,
  // reducing ~40 req/sec to ~1 req/sec during active generation.
  fastify.post(
    '/batch',
    {
      config: { rateLimit: webhookRateLimit },
      bodyLimit: 5_242_880, // 5 MB — batch of up to 500 events
    },
    async (request, reply) => {
      // 1. Resolve hook token → user (same as single endpoint)
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid or missing authorization token', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const hookUserId = resolution.userId;

      const rawBearerToken = extractBearerToken(request);
      if (!rawBearerToken) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing Bearer token', statusCode: 401 };
        return reply.code(401).send(error);
      }

      const hmacSecret = hookUserId ? rawBearerToken : config.hookToken;

      // 2. Verify timestamp
      const timestampHeader = request.headers['x-conduit-timestamp'] as string | undefined;
      if (!timestampHeader) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing X-Conduit-Timestamp header', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const timestamp = parseInt(timestampHeader, 10);
      if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired timestamp', statusCode: 401 };
        return reply.code(401).send(error);
      }

      // 3. Verify HMAC (signed over the entire batch body)
      const signatureHeader = request.headers['x-conduit-signature'] as string | undefined;
      if (!signatureHeader) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing X-Conduit-Signature header', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const rawBody = JSON.stringify(request.body);
      const signingData = `${timestampHeader}.${rawBody}`;
      const signature = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
      if (!verifyHmacSignature(hmacSecret, signingData, signature)) {
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid signature', statusCode: 401 };
        return reply.code(401).send(error);
      }

      // 4. Validate batch body
      const body = request.body as { events?: unknown };
      if (!body || !Array.isArray(body.events)) {
        const error: ApiError = { error: 'Validation Error', message: 'Body must be { events: HookPayload[] }', statusCode: 400 };
        return reply.code(400).send(error);
      }
      if (body.events.length > 500) {
        const error: ApiError = { error: 'Validation Error', message: 'Batch size exceeds maximum of 500 events', statusCode: 400 };
        return reply.code(400).send(error);
      }

      // Parse and validate each event, collecting valid ones
      const validEvents: Array<{ payload: HookPayload; eventId: string }> = [];
      let skippedCount = 0;
      for (const raw of body.events) {
        const parsed = hookPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          // C-03: Log skipped events so operators can debug misconfigured agents.
          // Log at debug level to avoid flooding production logs during normal operation.
          skippedCount++;
          fastify.log.debug(
            { issues: parsed.error.issues, event: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).event : undefined },
            'Batch webhook: skipping malformed event',
          );
          continue;
        }
        validEvents.push({ payload: parsed.data as HookPayload, eventId: randomUUID() });
      }

      if (skippedCount > 0) {
        fastify.log.warn({ skipped: skippedCount, total: body.events.length }, 'Batch webhook: skipped malformed events');
      }

      if (validEvents.length === 0) {
        return reply.code(200).send({ received: true, count: 0, skipped: skippedCount });
      }

      const db = fastify.db;

      // 5. Resolve instance_id — detect type from first event (all events in a batch
      //    come from the same agent instance so type is uniform)
      const firstEvent = validEvents[0]!.payload;
      const isOpenCodeBatch = (firstEvent.event as string).includes('.');
      const instanceType = isOpenCodeBatch ? 'opencode' : 'claude-code';

      let instanceRow: { id: string } | undefined;
      if (hookUserId) {
        instanceRow = db.query(
          `SELECT id FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1`,
        ).get(instanceType, hookUserId) as { id: string } | undefined;
      } else {
        instanceRow = db.query(
          `SELECT id FROM instances WHERE type = ? ORDER BY last_seen DESC LIMIT 1`,
        ).get(instanceType) as { id: string } | undefined;
      }

      if (!instanceRow) {
        const newInstanceId = randomUUID();
        db.query(
          `INSERT INTO instances (id, name, type, user_id, status, last_seen, created_at)
           VALUES (?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))`,
        ).run(newInstanceId, instanceType === 'opencode' ? 'OpenCode' : 'Claude Code', instanceType, hookUserId);
        instanceRow = { id: newInstanceId };
      }

      const instanceId = instanceRow.id;
      const prevBatchStatus = (db.query(`SELECT status FROM instances WHERE id = ?`).get(instanceId) as { status: string } | undefined)?.status;
      db.query(`UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ?`).run(instanceId);
      if (prevBatchStatus !== 'connected') {
        emitInstanceUpdated(db, instanceId);
      }

      // 6. Insert all events + track metrics in a single transaction
      const aggregator = fastify.metricsAggregator;

      const insertEvent = db.prepare(
        `INSERT INTO hook_events (id, instance_id, event_type, session_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      const upsertConfig = db.prepare(
        `INSERT INTO config_snapshots (instance_id, agent_type, content, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(instance_id) DO UPDATE SET
           content    = excluded.content,
           agent_type = excluded.agent_type,
           updated_at = datetime('now')`,
      );

      db.transaction(() => {
        for (const { payload, eventId } of validEvents) {
          const eventType = payload.event as string;
          const data = payload.data as Record<string, unknown>;

          insertEvent.run(eventId, instanceId, eventType, payload.sessionId, JSON.stringify(data));

          // Metrics tracking — same logic as single endpoint
          if (hookUserId) {
            if (eventType === 'message.updated') {
              const info = data['info'] as Record<string, unknown> | undefined;
              const msgId = (info?.['id'] as string) ?? (data['id'] as string) ?? eventId;
              aggregator.trackMessage(hookUserId, instanceId, msgId);
              const role = info?.['role'] as string | undefined;
              if (role === 'assistant') {
                const tokensObj = info?.['tokens'] as Record<string, unknown> | undefined;
                const cacheObj = tokensObj?.['cache'] as Record<string, number> | undefined;
                const input = (tokensObj?.['input'] as number) ?? 0;
                const output = (tokensObj?.['output'] as number) ?? 0;
                const reasoning = (tokensObj?.['reasoning'] as number) ?? 0;
                const totalTokens = input + output + reasoning;
                if (totalTokens > 0) {
                  const modelId = (info?.['modelID'] as string) ?? '';
                  const provider = (info?.['providerID'] as string) ?? '';
                  // Compute cost server-side — OpenCode always reports cost: 0
                  // Fire-and-forget within the transaction context (Promise resolves after tx commits)
                  pricingService.computeCost(modelId, provider, {
                    input,
                    output,
                    reasoning,
                    cache: { read: cacheObj?.['read'], write: cacheObj?.['write'] },
                  }).then((cost) => {
                    aggregator.trackTokensAndCost(hookUserId, instanceId, msgId, totalTokens, cost);
                  }).catch(() => {
                    aggregator.trackTokensAndCost(hookUserId, instanceId, msgId, totalTokens, 0);
                  });
                }
              }
            }

            if (eventType === 'UserPromptSubmit') {
              aggregator.trackMessage(hookUserId, instanceId, eventId);
            }

            if (eventType === 'message.part.updated') {
              const part = data['part'] as Record<string, unknown> | undefined;
              if (part?.['type'] === 'tool') {
                const state = part['state'] as Record<string, unknown> | undefined;
                if (state?.['status'] === 'pending') {
                  const callId = (part['callID'] as string) ?? eventId;
                  aggregator.trackToolCall(hookUserId, instanceId, callId);
                }
              }
            }

            // PostToolUse only — PreToolUse would double-count, tool.execute.after
            // is already covered by message.part.updated status=pending for OpenCode
            if (eventType === 'PostToolUse') {
              aggregator.trackToolCall(hookUserId, instanceId, eventId);
            }
          }

          // Config sync — upsert snapshot
          if (eventType === 'config.sync') {
            const configContent = typeof data['content'] === 'string'
              ? data['content']
              : JSON.stringify(data['content'] ?? data);
            upsertConfig.run(instanceId, instanceType, configContent);
          }

          // Models sync — replace model list for this instance
          if (eventType === 'models.sync') {
            const rawModels = data['models'];
            if (Array.isArray(rawModels)) {
              db.query(`DELETE FROM instance_models WHERE instance_id = ?`).run(instanceId);
              const upsertModel = db.prepare(`
                INSERT INTO instance_models (instance_id, provider_id, model_id, model_name, synced_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(instance_id, provider_id, model_id) DO UPDATE SET
                  model_name = excluded.model_name,
                  synced_at  = datetime('now')
              `);
              for (const m of rawModels) {
                if (
                  m && typeof m === 'object' &&
                  typeof (m as Record<string, unknown>)['providerId'] === 'string' &&
                  typeof (m as Record<string, unknown>)['modelId'] === 'string' &&
                  typeof (m as Record<string, unknown>)['modelName'] === 'string'
                ) {
                  const model = m as { providerId: string; modelId: string; modelName: string };
                  upsertModel.run(instanceId, model.providerId, model.modelId, model.modelName);
                }
              }
            }
          }
        }
      })();

      // 7. Broadcast all events to SSE clients (outside transaction — non-critical).
      // Apply the same Claude Code → SSE event type mapping as the single-event route.
      for (const { payload, eventId } of validEvents) {
        const sseEventType = toSSEEventType(payload.event);
        if (sseEventType !== null) {
          eventBus.emit(sseEventType, {
            id: eventId,
            instanceId,
            sessionId: payload.sessionId,
            event: payload.event,
            data: payload.data,
            timestamp: payload.timestamp,
          });
        }
      }

      return reply.code(200).send({ received: true, count: validEvents.length, skipped: skippedCount });
    },
  );

  // GET /hooks/token — user-facing endpoint to retrieve the per-user hook token status + detected caller IP.
  // SECURITY (A-02): The raw token is never stored in the DB. On first access (no token yet), a new
  // token is generated and returned in plaintext exactly once. On subsequent calls, only the prefix is
  // returned (isSet: true, token: null) — the user must use POST /hooks/token/regenerate to get a new one.
  // Uses GET (no CSRF needed for read-only operations) so it works from mobile WebViews where
  // CapacitorHttp may not forward custom headers like X-Requested-With for POST requests.
  fastify.get(
    '/token',
    { preHandler: [requireAuth], config: { rateLimit: apiReadRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // SECURITY: Use request.ip which Fastify resolves correctly using the
      // configured trustProxy list. Do NOT manually parse cf-connecting-ip or
      // x-forwarded-for — that bypasses trustProxy and allows IP spoofing.
      const detectedIp = isPublicIp(request.ip) ? request.ip : null;

      const existing = db.query(
        `SELECT token_prefix FROM hook_tokens WHERE user_id = ? LIMIT 1`,
      ).get(userId) as { token_prefix: string } | undefined;

      if (existing) {
        // Token already exists — return masked representation only.
        // The plaintext can only be retrieved by regenerating via POST /hooks/token/regenerate.
        const response: ApiSuccess<{ token: null; prefix: string; isSet: true; detectedIp: string | null }> = {
          data: { token: null, prefix: existing.token_prefix, isSet: true, detectedIp },
        };
        return reply.code(200).send(response);
      }

      // No token yet — generate one and return it this one time.
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string; isSet: false; detectedIp: string | null }> = {
        data: { token: newToken, prefix: tokenPrefix, isSet: false, detectedIp },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/token — kept for backward compatibility (web app used this before).
  // The GET variant above is preferred for mobile clients.
  // Same semantics: returns token plaintext only on first creation; masked on subsequent calls.
  fastify.post(
    '/token',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // SECURITY: Use request.ip which Fastify resolves correctly using the
      // configured trustProxy list. Do NOT manually parse cf-connecting-ip or
      // x-forwarded-for — that bypasses trustProxy and allows IP spoofing.
      const detectedIp = isPublicIp(request.ip) ? request.ip : null;

      const existing = db.query(
        `SELECT token_prefix FROM hook_tokens WHERE user_id = ? LIMIT 1`,
      ).get(userId) as { token_prefix: string } | undefined;

      if (existing) {
        const response: ApiSuccess<{ token: null; prefix: string; isSet: true; detectedIp: string | null }> = {
          data: { token: null, prefix: existing.token_prefix, isSet: true, detectedIp },
        };
        return reply.code(200).send(response);
      }

      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string; isSet: false; detectedIp: string | null }> = {
        data: { token: newToken, prefix: tokenPrefix, isSet: false, detectedIp },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/token/regenerate — regenerate the per-user hook token.
  // Always returns the new plaintext token exactly once.
  fastify.post(
    '/token/regenerate',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // Delete existing token(s) for this user
      db.query(`DELETE FROM hook_tokens WHERE user_id = ?`).run(userId);

      // Create a new token — return plaintext this one time only (never stored)
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string }> = {
        data: { token: newToken, prefix: tokenPrefix },
      };
      return reply.code(200).send(response);
    },
  );
}
