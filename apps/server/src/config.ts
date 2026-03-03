import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readSecret(name: string): string | undefined {
  const secretPath = join('/run/secrets', name);
  try {
    return readFileSync(secretPath, 'utf-8').trim();
  } catch {
    return process.env[name];
  }
}

function requireSecret(name: string): string {
  const value = readSecret(name);
  if (!value) {
    throw new Error(
      `Required secret "${name}" is not set. Provide via /run/secrets/${name} or environment variable.`,
    );
  }
  return value;
}

export const config = {
  port: Number.parseInt(readSecret('CONDUIT_PORT') ?? '3443', 10) || 3443,
  host: readSecret('CONDUIT_HOST') ?? '0.0.0.0',
  appUrl: readSecret('APP_URL') ?? 'http://localhost:5173',
  apiUrl: readSecret('API_URL') ?? 'http://localhost:3443',
  databasePath: readSecret('DATABASE_PATH') ?? './data/conduit.db',

  // Additional trusted origins for the Capacitor Android app.
  // 'capacitor://localhost' is the scheme used by the Android WebView.
  // 'https://localhost' is the androidScheme configured in capacitor.config.ts.
  capacitorOrigins: (readSecret('CAPACITOR_ORIGINS') ?? 'capacitor://localhost,https://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: '' as string,
  jwtRefreshSecret: '' as string,

  resendApiKey: readSecret('RESEND_API_KEY') ?? '',
  emailFrom: readSecret('RESEND_FROM_EMAIL') ?? readSecret('EMAIL_FROM') ?? 'Conduit <noreply@example.com>',

  hookToken: readSecret('CONDUIT_HOOK_TOKEN') ?? '',

  // Android App Links — SHA-256 fingerprint of the APK signing certificate.
  // Set ASSETLINKS_FINGERPRINT in Dokploy (server env vars). Never hardcode.
  // Format: 32 colon-separated hex pairs, e.g. AB:CD:EF:...
  // Served at GET /.well-known/assetlinks.json; returns 404 if not set.
  assetlinksFingerprint: (() => {
    const raw = readSecret('ASSETLINKS_FINGERPRINT') ?? '';
    if (!raw) return '';
    if (/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(raw)) return raw;
    // eslint-disable-next-line no-console
    console.warn('[config] ASSETLINKS_FINGERPRINT has invalid format (expected 32 colon-separated hex pairs), ignoring');
    return '';
  })(),

  opencodeUrl: readSecret('OPENCODE_SERVER_URL') ?? readSecret('OPENCODE_URL') ?? 'http://localhost:3000',
  opencodePassword: readSecret('OPENCODE_SERVER_PASSWORD') ?? readSecret('OPENCODE_PASSWORD') ?? '',

  // OAuth providers — all optional. If a clientId is set without its secret,
  // validateConfig() will throw. Both must be set for the provider to be active.
  githubClientId:     readSecret('GITHUB_CLIENT_ID')     ?? '',
  githubClientSecret: readSecret('GITHUB_CLIENT_SECRET') ?? '',
  gitlabClientId:     readSecret('GITLAB_CLIENT_ID')     ?? '',
  gitlabClientSecret: readSecret('GITLAB_CLIENT_SECRET') ?? '',
  // For self-hosted GitLab. Must be https:// in production (enforced by validateConfig).
  gitlabBaseUrl:      readSecret('GITLAB_BASE_URL')      ?? 'https://gitlab.com',

  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  isProduction: process.env['NODE_ENV'] === 'production',
} satisfies Record<string, string | number | boolean | string[]>;

export type Config = typeof config;

export function validateConfig(): void {
  config.jwtSecret = requireSecret('JWT_SECRET');
  config.jwtRefreshSecret = requireSecret('JWT_REFRESH_SECRET');

  if (config.jwtSecret.length < 64) {
    throw new Error('JWT_SECRET must be at least 64 characters long');
  }
  if (config.jwtRefreshSecret.length < 64) {
    throw new Error('JWT_REFRESH_SECRET must be at least 64 characters long');
  }
  // SECURITY: Access and refresh tokens must use distinct secrets.
  // Reusing the same secret allows any valid access token to be presented
  // as a refresh token (and vice versa), bypassing audience validation.
  if (config.jwtSecret === config.jwtRefreshSecret) {
    throw new Error(
      'JWT_SECRET and JWT_REFRESH_SECRET must be different values. ' +
      'Using the same secret allows token-type confusion attacks.',
    );
  }

  if (config.hookToken.length < 64) {
    throw new Error('CONDUIT_HOOK_TOKEN must be at least 64 characters long');
  }

  // SECURITY (RFC 9700 §2.6): Authorization responses MUST NOT be transmitted over
  // unencrypted connections. Enforce https:// for API and GitLab base URLs in production.
  if (config.isProduction) {
    if (!config.apiUrl.startsWith('https://')) {
      throw new Error(
        'API_URL must use https:// in production (RFC 9700 §2.6 — OAuth callbacks require TLS)',
      );
    }
    if (config.gitlabBaseUrl && !config.gitlabBaseUrl.startsWith('https://')) {
      throw new Error(
        'GITLAB_BASE_URL must use https:// in production — plain HTTP would expose client_secret and authorization codes in transit',
      );
    }
  }

  // If a provider client ID is configured, its secret must also be present.
  if (config.githubClientId && !config.githubClientSecret) {
    throw new Error('GITHUB_CLIENT_SECRET must be set when GITHUB_CLIENT_ID is configured');
  }
  if (config.gitlabClientId && !config.gitlabClientSecret) {
    throw new Error('GITLAB_CLIENT_SECRET must be set when GITLAB_CLIENT_ID is configured');
  }

  // Reject known placeholder/default secrets that could be committed to source control
  const BANNED_PATTERNS = [
    'change-me', 'changeme', 'your-secret', 'your_secret',
    'replace-me', 'replaceme', 'todo', 'fixme', 'secret123',
    'password', 'default', 'example', 'placeholder',
  ];
  for (const secret of [config.jwtSecret, config.jwtRefreshSecret, config.hookToken]) {
    const lower = secret.toLowerCase();
    for (const pattern of BANNED_PATTERNS) {
      if (lower.includes(pattern)) {
        throw new Error(
          `JWT secret contains a known default/placeholder pattern ("${pattern}"). ` +
          'Generate a cryptographically random secret (e.g. openssl rand -base64 64).',
        );
      }
    }
  }
}
