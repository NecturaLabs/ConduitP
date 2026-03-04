# Conduit

## What Is This
A self-hosted, mobile-first dashboard for monitoring and controlling AI coding agents (OpenCode and Claude Code). Features real-time session streaming, remote config editing, device-flow agent pairing, multi-instance management, usage metrics/analytics, and 12 themeable UI skins.

## Tech Stack
- **Monorepo:** Turborepo + Bun workspaces (`apps/*`, `packages/*`, `cli/`)
- **Runtime / Package Manager:** Bun v1.3+ (uses **bun** everywhere — not npm)
- **TypeScript:** v5.7+, ES2022, strict mode with `noUncheckedIndexedAccess`
- **Frontend (Dashboard):** React 19 + Vite 7 + Tailwind CSS v4, Zustand 5, TanStack Query 5, React Router DOM 7, Recharts 3, CodeMirror 6
- **Frontend (Landing):** Next.js 16 (static export) + React 19 + Tailwind CSS v4
- **Backend:** Fastify v5 + Zod validation + hand-rolled JWT (HMAC-SHA256)
- **Database:** SQLite via `bun:sqlite` (WAL mode, foreign keys)
- **Email:** Resend SDK (magic link auth)
- **Real-Time:** SSE relay (backend proxies OpenCode events to frontend)
- **CI/CD:** GitHub Actions → Dokploy source-deploy (builds Docker on server) + Netlify
- **Reverse Proxy:** Nginx Alpine (self-hosted variant) with TLS termination
- **Testing:** Vitest + Testing Library + V8 coverage

## Production Deployment
- **Landing + Dashboard:** Netlify (dashboard under `/app/`)
- **Backend:** Dokploy (Docker) — builds from GitHub source
- **CI/CD:** `.github/workflows/deploy-frontend.yml` and `deploy-server.yml` trigger on push to `main`
- **Email sender:** configured via `RESEND_FROM_EMAIL` env var (via Resend)
- **Monitor CI:** `gh run list --repo NecturaLabs/Conduit --limit 5`
- **Persistent volume (Dokploy):** The SQLite DB lives at `/app/data/conduit.db` inside the container. Dokploy source-deploy wipes the container on every redeploy — configure a bind mount in Dokploy → service → Advanced → Volumes: host path `/var/lib/conduit/data` → container path `/app/data`. Without this, all sessions and refresh tokens are wiped on every deploy. (The `docker-compose.yml` self-hosted stack already handles this via a named Docker volume.)
- **Environment variables for builds:** `VITE_API_URL` is injected at Netlify build time (repo variable). `CONDUIT_API_HOST` is a GitHub Actions repo variable used for Android App Links in `build-android.yml`. Neither is committed to the repo.

## Mobile (Android)

The Android app is a Capacitor v8 shell that wraps the web dashboard (`apps/web/dist`) in a native WebView.

### Structure
```
apps/
  mobile/                    @conduit/mobile — Capacitor Android shell
    capacitor.config.ts      App config: appId, webDir, plugins, loggingBehavior
    package.json             Capacitor deps only (@capacitor/core, android, plugins)
    android/                 Generated Android Studio project (committed)
```

### Dev workflow
```bash
# 1. Build web app
bun run build --filter=@conduit/web

# 2. Sync web assets + plugins to Android
cd apps/mobile && bunx cap sync android

# 3. Open in Android Studio (to run on emulator/device)
bunx cap open android

# 4. Or run directly on connected device
bunx cap run android
```

### APK build (automated)
Every push to `main` that touches `apps/mobile/` or `apps/web/src/` triggers `.github/workflows/build-android.yml`, which:
1. Builds the web app
2. Syncs Capacitor
3. Runs `./gradlew assembleRelease`
4. Signs the APK using secrets stored in GitHub Actions
5. Publishes a GitHub Release with the `.apk` as a download

### One-time keystore setup
Run `scripts/generate-keystore.sh` once, then add the 4 output values as GitHub Actions secrets:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEY_ALIAS`
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_PASSWORD`

The `.keystore` file is in `.gitignore` — back it up securely.

### Security notes
- `loggingBehavior: 'none'` is set in `capacitor.config.ts` and must stay that way in production builds. For local debugging only, temporarily set to `'debug'` — never commit that change.
- `CapacitorCookies.enabled: true` is required for httpOnly JWT cookies to work through the WebView. This makes cookies accessible at the native plugin layer (Kotlin) but not from JavaScript.
- The server's CORS, CSRF, and cookie `SameSite` logic all explicitly handle `capacitor://localhost` and `https://localhost` origins. See `apps/server/src/config.ts` (`capacitorOrigins`), `app.ts`, `middleware/auth.ts`, and `routes/auth.ts`.
- FCM service account (if ever added for push notifications) must be scoped to `firebase.messaging` only — not the default Firebase Admin account.

## Architecture
```
apps/
  mobile/                           # @conduit/mobile — Capacitor v8 Android shell
    capacitor.config.ts             # App config: appId, webDir, plugins, security settings
    package.json                    # Capacitor + plugin deps
    android/                        # Generated Android project (committed, built by CI)

  server/                           # @conduit/server — Fastify v5 API backend
    Dockerfile                      # Bun Alpine, runs TS natively (no tsc build)
    src/
      index.ts                      # Entry: validates config, starts server, graceful shutdown
      app.ts                        # Fastify instance: plugins, CORS, Helmet, rate limit, route registration
      config.ts                     # Config from env vars or /run/secrets/* (Docker secrets support)
      db/
        schema.ts                   # SQL DDL: users, magic_link_tokens, refresh_tokens, revoked_access_tokens, instances, hook_events, metrics_snapshots, config_snapshots, config_pending, pending_prompts, hook_tokens, metrics_counters, archived_sessions, oauth_states, oauth_connections, metrics_dedup
        migrate.ts                  # Runs schema in a transaction on startup
        index.ts                    # Initializes bun:sqlite, WAL mode, foreign keys (singleton via getDatabase())
      lib/
        db-helpers.ts               # Shared DB utilities: normalizeTs(), mapUserRow()
        sse.ts                      # Shared SSE utilities: sanitizeEventType(), encodeSSEData()
        auth-cookies.ts             # Cookie config helpers
      middleware/
        auth.ts                     # requireAuth (JWT from cookie), requireCsrf (X-Requested-With header)
        hook-auth.ts                # Shared hook/bearer auth: verifyBearerToken(), verifyHookToken(), extractBearerToken(), requireHookToken()
        rateLimit.ts                # Rate limit configs: auth (5/15min), webhook (200/1min)
      routes/
        auth.ts                     # Magic link send/verify, token refresh with rotation & reuse detection, logout, /me
        onboarding.ts               # POST displayName + useCase after first login
        sessions.ts                 # List/detail/delete sessions, POST prompt to running session (proxied to agent)
        config.ts                   # GET/PATCH config (proxied to agent), config/pending + config/ack for dashboard-queued updates
        events.ts                   # SSE relay: proxies OpenCode /global/event to authenticated frontend
        hooks.ts                    # Webhook receiver (Bearer + HMAC-SHA256 + timestamp replay protection), RFC 8628 device flow (approve/poll/install), install/uninstall script generators (bash + PowerShell); emits instance.updated SSE on status change
        prompts.ts                  # Prompt relay: POST, SSE polling, acknowledgement; uses EventBus from eventbus.ts
        metrics.ts                  # Summary, timeseries, and dashboard aggregate endpoints
        instances.ts                # CRUD agent instances, connection test (emits SSE after status write), heartbeat (POST /instances/heartbeat — keeps instance connected while idle), deregister endpoint (bearer-authed); DELETE and deregister clean up metrics_counters + hook_events before deleting instance row to satisfy FK constraints
        oauth.ts                    # OAuth 2.0 PKCE: GitHub + GitLab (optional)
      services/
        auth.ts                     # Hand-rolled JWT (HS256), magic link tokens, HMAC signatures, timing-safe comparisons
        email.ts                    # Resend SDK: magic link HTML email (accepts optional logger)
        eventbus.ts                 # Generic typed EventBus (pub/sub for SSE prompt delivery)
        cleanup.ts                  # Periodic cleanup of expired tokens and stale data (accepts logger param)
        opencode.ts                 # OpenCode REST API client: sessions, messages, config, SSE subscription, health check
        metrics.ts                  # Metrics capture, summary, and timeseries queries (batch query, no N+1)
        oauth.ts                    # OAuth 2.0 PKCE helpers: state generation, code exchange, provider clients
        pricing.ts                  # Pricing and token cost calculations
        metrics-aggregator.ts       # Background metrics aggregation and deduplication
        url-validation.ts           # SSRF-safe URL validation (blocks cloud metadata IPs, enforces https)
    tests/
      setup.ts                      # In-memory SQLite, test user/token factories
      auth.test.ts                  # Auth service + routes tests
      hooks.test.ts                 # Webhook routes tests

  web/                              # @conduit/web — React 19 + Vite Dashboard SPA
    Dockerfile.static               # Multi-stage: build with Bun, output to Alpine for nginx volume
    # .env.production is gitignored — VITE_API_URL is injected at build time via Netlify env vars / CI
    src/
      main.tsx                      # React root: StrictMode, QueryClient, BrowserRouter (basename=/app)
      main.css                      # Tailwind + all 12 theme CSS files
      App.tsx                       # Routes: /auth, /onboarding, /activate, /dashboard, /sessions, /config, /metrics, /settings
      pages/
        Auth.tsx                    # Login (magic link)
        Onboarding.tsx              # Post-signup setup (name, use case)
        Activate.tsx                # Device flow approval UI (user code entry)
        Dashboard.tsx               # Main overview
        Sessions.tsx                # Session list + detail view
        Config.tsx                  # Remote agent config editor
        Metrics.tsx                 # Charts and analytics
        Settings.tsx                # Instances, hook tokens, theme
      components/
        auth/                       # MagicLinkForm, ProtectedRoute (blocks render until first session probe completes via initialValidating state)
        layout/                     # AppLayout, Sidebar, TopBar
        sessions/                   # SessionCard, SessionList
        config/                     # ConfigEditor (CodeMirror)
        metrics/                    # MetricsChart (Recharts)
        agents/                     # AgentCard
        theme/                      # ThemeSwatch
        ui/                         # Badge, Button, Card, Input, Select, Skeleton, Spinner (design system)
      hooks/
        useSSE.ts                   # EventSource with exponential backoff reconnection (1s–30s)
        useSessions.ts              # TanStack Query hooks for sessions CRUD
        useMetrics.ts               # TanStack Query hooks for metrics (auto-refresh 60s)
        useInstances.ts             # TanStack Query hooks for instances CRUD + test
      store/
        auth.ts                     # Zustand + persist: user, isAuthenticated, isOnboarded
        theme.ts                    # Zustand + persist: theme selection (12 themes)
        instances.ts                # Zustand: instance list, selection
      lib/
        api.ts                      # Fetch wrapper: auto-unwrap ApiSuccess, auto-refresh on 401, CSRF header
        utils.ts                    # cn() (clsx+twMerge), relativeTime(), formatNumber(), normalizeDate(), getInstanceLabel()
      themes/                       # 12 CSS theme files: midnight, phosphor, frost, aurora, ember, ocean, rose, cobalt, sakura, copper, slate, neon

  landing/                          # @conduit/landing — Next.js 15 static landing page
    next.config.ts                  # output: 'export', trailingSlash, unoptimized images
    app/
      layout.tsx                    # Root layout: Inter font, Navbar, Footer
      page.tsx                      # Homepage: Hero, Features, HowItWorks, ThemePreview, OpenSource
      pricing/page.tsx              # Pricing page
      components/                   # FadeIn, Features, Footer, Hero, HowItWorks, Navbar, OpenSource, PricingCard, ThemePreview

packages/
  shared/                           # @conduit/shared — Shared TypeScript types
    src/
      index.ts                      # Re-exports all types
      types/
        api.ts                      # ApiError, ApiSuccess<T>, PaginationParams
        auth.ts                     # MagicLinkRequest/Response, JWTPayload, RefreshJWTPayload
        user.ts                     # User, OnboardingPayload, UserProfile
        session.ts                  # Session, ToolCall, SessionMessage, SessionListResponse, SessionDetailResponse
        events.ts                   # SSEEventType, SSEEvent<T>, SessionEvent, MessageEvent, ToolEvent, etc.
        hooks.ts                    # HookEventType, HookPayload, HookResponse, OpenCodeEventType
        config.ts                   # ConfigEntry, ConfigListResponse, ConfigUpdateRequest/Response
        metrics.ts                  # MetricsSummary, MetricsTimeSeries, MetricsDashboard
        instance.ts                 # AgentType, InstanceStatus, Instance, InstanceListResponse

  mcp-server/                       # @conduit-ai/mcp-server — Published MCP server package (npm)
    src/
      index.ts                      # MCP server entry: auto-bootstraps push hooks, exposes MCP tools via stdio transport
    # MCP Tools exposed:
    #   register_instance   — Register this agent instance with Conduit dashboard
    #   check_prompts       — Poll for pending prompts queued from the dashboard
    #   report_event        — Send a hook event (HMAC-signed) to Conduit
    #   list_sessions       — List recent sessions tracked by Conduit
    #   get_session         — Get full session detail (messages, tool calls, token usage)
    #   ack_prompt          — Acknowledge a delivered/failed prompt
    #   sync_models         — Sync available model list to dashboard
    #   get_metrics         — Fetch usage metrics (today/week/month/all)
    # Auto-bootstrap on startup:
    #   - Installs OpenCode plugin to ~/.config/opencode/plugins/conduit.js if opencode config dir exists
    #   - Installs Claude Code bash/PS1 hook helper + merges settings.json if ~/.claude exists
    #   - Calls POST /instances/register with detected instance type
    #   - Starts 60s heartbeat interval calling POST /instances/heartbeat
    # Instance type detection priority: CONDUIT_INSTANCE_TYPE env override → OPENCODE=1 → ~/.claude/ exists → 'unknown'
    # sendConfigSync() and sendModelsSync() are skipped when instance type is 'opencode' (OpenCode handles these natively)
    # Required env vars: CONDUIT_API_URL, CONDUIT_HOOK_TOKEN
    # Optional env vars: CONDUIT_INSTANCE_NAME, CONDUIT_INSTANCE_TYPE, CONDUIT_SKIP_BOOTSTRAP
    # Published to npm as @conduit-ai/mcp-server (bin: conduit-mcp)
    # SSRF protection: blocks known cloud metadata IPs, requires https for non-localhost

cli/                                # @conduit/cli — Claude Code hook installer (legacy, replaced by device flow + MCP server)
  src/
    install-hooks.ts                # Reads ~/.claude/settings.json, adds/removes Conduit hooks

scripts/
  setup.sh                          # Self-hosted setup: generates ECDSA P-256 TLS cert and data dir (does NOT generate .env)
  generate-secrets.sh               # Generates JWT_SECRET, JWT_REFRESH_SECRET, CONDUIT_HOOK_TOKEN and writes them to .env
  build-netlify.sh                  # Builds landing + web, merges into single Netlify publish dir, writes _redirects + _headers
  build-android-local.sh            # Local Android APK build helper
  generate-keystore.sh              # Generates Android signing keystore and prints GitHub Actions secrets

nginx/
  nginx.conf                        # Production nginx: HTTPS, TLS 1.2+, gzip, rate limiting, SSE proxy config, SPA fallback

.github/
  workflows/
    deploy-frontend.yml             # Build & deploy landing+web to Netlify
    deploy-server.yml               # Bun build check, trigger Dokploy source-deploy
    dependabot-automerge.yml        # Auto-approve & squash-merge Dependabot patch PRs
    build-android.yml               # Build, sign, and publish Android APK on push to main
    publish-mcp-server.yml          # Publish @conduit-ai/mcp-server to npm on release
    security.yml                    # Security scanning (Gitleaks, dependency audit)
  dependabot.yml                    # Daily checks: bun, GitHub Actions, Docker
```

## Security Architecture

### Authentication
- **Magic link email** via Resend: 256-bit entropy token, SHA-256 hashed in DB, 15-min TTL, single-use
- **JWT access tokens:** Hand-rolled HMAC-SHA256, 2-hour expiry, `httpOnly` + `Secure` + `SameSite` derived (`lax` same-site, `none` cross-origin; Capacitor forced `lax`)
- **JWT refresh tokens:** 30-day expiry, family-based rotation with **reuse detection** (compromised family revoked entirely)
- **Access token revocation:** Tracked in `revoked_access_tokens` table with TTL
- **CSRF protection:** `X-Requested-With: XMLHttpRequest` header required on all mutating requests
- **Frontend auto-refresh:** API client transparently retries on 401, coalescing concurrent refresh attempts
- **OAuth 2.0 PKCE (GitHub, GitLab):** state parameter + PKCE code verifier, stored in `oauth_states` table with TTL; enforces https:// for all OAuth callbacks in production (RFC 9700 §2.6)

### Webhook Security
- **3-layer validation:** Bearer token (timing-safe) + HMAC-SHA256 signature + timestamp replay protection (±5 min window)
- **All timing-sensitive comparisons** use `crypto.timingSafeEqual`

### General Hardening
- Helmet CSP configured, security headers (X-Frame-Options DENY, nosniff, HSTS with preload)
- Server removes `Server` and `X-Powered-By` headers
- Config reads from Docker secrets (`/run/secrets/*`) with env var fallback
- Secrets require minimum 64 characters
- Non-root Docker container (UID 1001)
- Nginx: `server_tokens off`, TLS 1.2+, rate limiting on `/api/auth/`
- `TRUSTED_PROXIES`: configurable trusted proxy list for correct client IP extraction behind load balancers

## Key Concepts

### Device Flow (RFC 8628)
Agent installation uses an OAuth-style device flow. The terminal runs a bootstrap script that:
1. Calls `POST /hooks/install/device` → gets a `user_code` (XXXX-XXXX consonant format) + `device_code`
2. User opens `/app/activate` in browser, enters the user code
3. Browser calls `POST /hooks/install/approve` to approve the pairing
4. Terminal polls `POST /hooks/install/poll` → receives the install script on approval
5. Install script configures the agent (Claude Code hooks in `settings.json`, or OpenCode plugin) with HMAC secrets and instance registration

### MCP Server (`@conduit-ai/mcp-server`)
An alternative install method — users add Conduit as an MCP server in their agent config. On startup it:
- Auto-bootstraps push hooks for detected agents (OpenCode plugin, Claude Code settings.json)
- Connects to `GET /api/prompts/stream` (SSE) and forwards `prompt.queued` events as MCP `logging` notifications at `emergency` level so the agent sees and acts on them
- Exposes 8 MCP tools for session management, prompt relay, metrics, and event reporting

### SSE Relay
- Backend proxies OpenCode's `/global/event` SSE stream to the authenticated frontend
- Nginx configured for SSE: `proxy_buffering off`, `proxy_read_timeout 0`
- Frontend uses `EventSource` with credentials, exponential backoff (1s initial, 30s max)

### Config Sync
- Dashboard can queue config changes in `config_pending` table
- On `SessionStart`, the agent hook pushes a `config.sync` event and pulls pending config via `GET /config/pending`
- Agent applies the config and ACKs via `POST /config/ack`, which deletes the pending entry

### Multi-Instance Support
- Users register agent instances (OpenCode or Claude Code) with name, type, and URL
- Each instance can be connection-tested (`/global/health` ping)
- Metrics and hook events tracked per-instance
- Instances can self-deregister via bearer-authed `POST /instances/deregister`

### Theming
- 12 themes: Midnight, Phosphor, Frost, Aurora, Ember, Ocean, Rose, Cobalt, Sakura, Copper, Slate, Neon
- CSS custom properties via `data-theme` attribute on `<html>`
- Frost and Sakura are light themes; all others are dark
- Persisted in localStorage via Zustand persist middleware

## Code Standards
- **Strict TypeScript** — no `any` types. Use proper generics, `unknown` + type guards, or specific types.
- **ESM throughout** — `"type": "module"` in all packages.
- **All shared types** live in `@conduit/shared` — no duplicated type definitions.
- **API response envelope** — `ApiSuccess<T> = { data: T, meta? }` and `ApiError = { error, message, statusCode }`.
- **Zod validation** on all route inputs. All SQL uses prepared statements.
- **Frontend state split** — Zustand for client state (auth, theme, instances), TanStack Query for server state.
- **Component organization** — by feature domain (`auth/`, `sessions/`, `metrics/`) plus `ui/` for design system primitives.
- **Path alias** — `@/` in frontend (Vite + tsconfig).
- **`cn()` utility** — `clsx` + `tailwind-merge` for className composition.
- **Frontend uses bun** — not npm. Use `bun install`, `bun run build`, etc.
- **Small commits** — one logical change per commit with clear messages.
- **No duplicated logic** — shared server utilities in `lib/` (SSE, DB helpers) and `middleware/hook-auth.ts`; shared frontend utilities in `lib/utils.ts`.
- **No dead code** — unused exports, components, and functions are removed.
- **Timer cleanup** — all `setTimeout`/`setInterval` in React use `useRef` + `useEffect` cleanup to prevent leaks.
- **Logger injection** — services accept an optional logger parameter rather than using `console.*` directly; server uses `fastify.log` (Pino).
- **DB access pattern** — route handlers use `fastify.db`; preHandlers/middleware use `request.server.db`. No standalone `getDatabase()` calls outside `db/index.ts`.
- **Accessibility** — interactive elements include ARIA attributes (`aria-haspopup`, `aria-expanded`, `role`).

## Token Efficiency
- Never re-read files you just wrote or edited. You know the contents.
- Never re-run commands to "verify" unless the outcome was uncertain.
- Don't echo back large blocks of code or file contents unless asked.
- Batch related edits into single operations. Don't make 5 edits when 1 handles it.
- Skip confirmations like "I'll continue..." Just do it.
- If a task needs 1 tool call, don't use 3. Plan before acting.
- Do not summarize what you just did unless the result is ambiguous or you need additional input.

## Important Notes
- Server Dockerfile runs Bun natively — no `tsc` build step. Bun transpiles TypeScript at runtime.
- Docker images pin Bun to `1.3` minor series (e.g. `oven/bun:1.3-alpine`).
- `.dockerignore` excludes `.git`, `node_modules`, build outputs, docs, and CI files to minimize Docker context.
- `netlify.toml` uses `--frozen-lockfile` for reproducible installs.
- GitHub Actions runners: set `TRUSTED_ACTORS` variable (comma-separated GitHub usernames, e.g. `Nectura`) to use self-hosted runners for those actors; all others use `ubuntu-latest`.
- GitHub Actions pin Bun to `1.2` (not `latest`) for reproducible CI builds.
- Database migrations are idempotent `CREATE TABLE IF NOT EXISTS` statements run in a transaction on startup.
- Build order (Turbo): `@conduit/shared` builds first (via `dependsOn: ["^build"]`), then all other packages in parallel.
- All workspace `tsconfig.json` files extend `../../tsconfig.base.json` for consistent compiler options.
- Tests use `app.inject()` (no network) with in-memory SQLite (`:memory:`).
- The CLI (`@conduit/cli`) is the legacy installer — device flow bootstrap scripts and the MCP server are the primary install methods now.
- Subagent sessions (those with `parentID`) are filtered out of the session list.
- GitHub repo: `NecturaLabs/Conduit`.
- The landing page's `FadeIn` component respects `prefers-reduced-motion` — elements become visible immediately without animation.
- `scripts/generate-secrets.sh` generates JWT_SECRET, JWT_REFRESH_SECRET, and CONDUIT_HOOK_TOKEN and writes them to `.env`; use it for initial self-hosted setup before running `docker compose up`.
- SQLite is configured with WAL mode, foreign keys ON, busy_timeout 5000ms, and secure_delete ON (see `apps/server/src/db/index.ts`). No migration to PostgreSQL is planned — WAL SQLite is sufficient for single-server deployments.
- `formatCost()` in `apps/web/src/lib/utils.ts` is the canonical cost formatter (handles zero-case as `$0.00`). All cost display in `Sessions.tsx` and `Metrics.tsx` uses it — no local duplicates.
- `apps/web/.env.production` is gitignored. `VITE_API_URL` is injected via Netlify environment variables at build time. Never commit `.env.production`.
- Android App Links host (`CONDUIT_API_HOST`) is a GitHub Actions repo variable passed to Gradle via `-PCONDUIT_API_HOST`. It replaces the `${conduitApiHost}` placeholder in `AndroidManifest.xml`.
