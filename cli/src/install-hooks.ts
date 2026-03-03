#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookEntry {
  type: "command";
  command: string;
}

interface HooksMap {
  [eventName: string]: HookEntry[];
}

interface ClaudeSettings {
  hooks?: HooksMap;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Arg parsing (zero deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  serverUrl: string;
  token: string;
  settingsPath: string;
  uninstall: boolean;
  help: boolean;
}

function printHelp(): void {
  const help = `
conduit – Install / uninstall Conduit hooks in Claude Code settings

USAGE
  conduit [options]

OPTIONS
  -s, --server-url <url>    Conduit server URL        (default: http://localhost:3443)
  -t, --token <token>       Hook bearer token          (env: CONDUIT_HOOK_TOKEN)
  -p, --settings-path <p>   Path to settings.json      (default: ~/.claude/settings.json)
  -u, --uninstall           Remove Conduit hooks
  -h, --help                Show this help message
`.trim();
  console.log(help);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    serverUrl: "http://localhost:3443",
    token: process.env["CONDUIT_HOOK_TOKEN"] ?? "",
    settingsPath: defaultSettingsPath(),
    uninstall: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-s":
      case "--server-url":
        args.serverUrl = requireNext(argv, ++i, arg);
        break;
      case "-t":
      case "--token":
        args.token = requireNext(argv, ++i, arg);
        break;
      case "-p":
      case "--settings-path":
        args.settingsPath = requireNext(argv, ++i, arg);
        break;
      case "-u":
      case "--uninstall":
        args.uninstall = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return args;
}

function requireNext(argv: string[], idx: number, flag: string): string {
  const val = argv[idx];
  if (val === undefined || val.startsWith("-")) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return val;
}

function defaultSettingsPath(): string {
  const home =
    process.platform === "win32"
      ? process.env["USERPROFILE"] ?? os.homedir()
      : os.homedir();
  return path.join(home, ".claude", "settings.json");
}

// ---------------------------------------------------------------------------
// Hook command builder
// ---------------------------------------------------------------------------

const HOOK_EVENTS = [
  "SessionStart",
  "Stop",
  "TaskCompleted",
  "SessionEnd",
] as const;

function buildHookCommand(serverUrl: string, token: string): string {
  // Single-line bash: read stdin, compute HMAC, POST fire-and-forget
  const url = `${serverUrl}/hooks`;
  return (
    `INPUT=$(cat); ` +
    `TS=$(date +%s); ` +
    `SIG=$(echo -n "\${TS}.\${INPUT}" | openssl dgst -sha256 -hmac "${token}" -hex | awk '{print $NF}'); ` +
    `curl -s -m 5 -X POST "${url}" ` +
    `-H "Authorization: Bearer ${token}" ` +
    `-H "X-Conduit-Signature: sha256=\${SIG}" ` +
    `-H "X-Conduit-Timestamp: \${TS}" ` +
    `-H "Content-Type: application/json" ` +
    `-d "\${INPUT}" > /dev/null 2>&1 &`
  );
}

function isConduitHook(entry: HookEntry, serverUrl: string): boolean {
  return entry.type === "command" && entry.command.includes(serverUrl);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function installHooks(
  settings: ClaudeSettings,
  serverUrl: string,
  token: string,
): { added: string[]; skipped: string[] } {
  const hooks: HooksMap = settings.hooks ?? {};
  const command = buildHookCommand(serverUrl, token);
  const added: string[] = [];
  const skipped: string[] = [];

  for (const event of HOOK_EVENTS) {
    const existing: HookEntry[] = hooks[event] ?? [];

    // Already installed? Skip.
    if (existing.some((e) => isConduitHook(e, serverUrl))) {
      skipped.push(event);
      continue;
    }

    hooks[event] = [...existing, { type: "command", command }];
    added.push(event);
  }

  settings.hooks = hooks;
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstallHooks(
  settings: ClaudeSettings,
  serverUrl: string,
): { removed: string[]; notFound: string[] } {
  const hooks: HooksMap = settings.hooks ?? {};
  const removed: string[] = [];
  const notFound: string[] = [];

  for (const event of HOOK_EVENTS) {
    const existing: HookEntry[] = hooks[event] ?? [];
    const filtered = existing.filter((e) => !isConduitHook(e, serverUrl));

    if (filtered.length < existing.length) {
      removed.push(event);
    } else {
      notFound.push(event);
    }

    if (filtered.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  // If hooks map is now empty, remove the key entirely.
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  return { removed, notFound };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readSettings(filePath: string): ClaudeSettings {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err: unknown) {
    // File doesn't exist — create it atomically (no TOCTOU race between
    // existsSync and writeFileSync). codeql[js/file-system-race]
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "{}\n", "utf-8");
      return {};
    }
    // File exists but contains invalid JSON
    if (err instanceof SyntaxError) {
      console.error(`Error: ${filePath} contains invalid JSON.`);
      process.exit(1);
    }
    throw err;
  }
}

function writeSettings(filePath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(settings, null, 2) + "\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.uninstall && !args.token) {
    console.error(
      "Error: --token (or CONDUIT_HOOK_TOKEN env var) is required for installation.",
    );
    process.exit(1);
  }

  const settings = readSettings(args.settingsPath);

  if (args.uninstall) {
    const { removed, notFound } = uninstallHooks(settings, args.serverUrl);
    writeSettings(args.settingsPath, settings);

    console.log(`Conduit hooks uninstalled from ${args.settingsPath}`);
    if (removed.length > 0) {
      console.log(`  Removed:   ${removed.join(", ")}`);
    }
    if (notFound.length > 0) {
      console.log(`  Not found: ${notFound.join(", ")}`);
    }
  } else {
    const { added, skipped } = installHooks(
      settings,
      args.serverUrl,
      args.token,
    );
    writeSettings(args.settingsPath, settings);

    console.log(`Conduit hooks installed to ${args.settingsPath}`);
    if (added.length > 0) {
      console.log(`  Added:   ${added.join(", ")}`);
    }
    if (skipped.length > 0) {
      console.log(`  Skipped: ${skipped.join(", ")}`);
    }
    console.log(`  Server:  ${args.serverUrl}`);
  }
}

main();
