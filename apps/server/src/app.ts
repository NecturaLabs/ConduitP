import Fastify from 'fastify';
import type { FastifyInstance, FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Database } from 'bun:sqlite';
import { initializeDatabase } from './db/index.js';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { oauthRoutes } from './routes/oauth.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { sessionRoutes } from './routes/sessions.js';
import { configRoutes, configAgentRoutes } from './routes/config.js';
import { eventRoutes } from './routes/events.js';
import { hookRoutes } from './routes/hooks.js';
import { metricsRoutes } from './routes/metrics.js';
import { instanceRoutes, instanceRegisterRoute, instanceDeregisterRoute, instanceHeartbeatRoute } from './routes/instances.js';
import { promptRelayRoutes } from './routes/prompts.js';
import { modelsRoutes } from './routes/models.js';
import { requireCsrf } from './middleware/auth.js';
import { startCleanupJob, stopCleanupJob } from './services/cleanup.js';
import { MetricsAggregator } from './services/metrics-aggregator.js';
import { pricingService } from './services/pricing.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    metricsAggregator: MetricsAggregator;
  }
}

export interface BuildAppOptions {
  dbPath?: string;
  skipSecretValidation?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Restrict trustProxy to known proxy IPs to prevent IP spoofing via
  // X-Forwarded-For headers. When set to `true`, ANY upstream can forge the
  // client IP and bypass rate limits. Default to loopback if not configured.
  // SECURITY (E-01): Validate each entry is a syntactically valid IPv4, IPv6, or CIDR.
  const rawProxies = process.env['TRUSTED_PROXIES']
    ? process.env['TRUSTED_PROXIES'].split(',').map((s) => s.trim()).filter(Boolean)
    : ['127.0.0.1', '::1'];

  // Basic IP/CIDR syntax validation — rejects obviously malformed entries.
  // Full semantic validation (e.g. reserved ranges) is intentionally excluded:
  // operators may legitimately trust a private proxy IP.
  const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  const ipv6Re = /^[0-9a-fA-F:]+(%\S+)?(\/\d{1,3})?$/;
  const trustedProxies = rawProxies.filter((entry) => {
    const valid = ipv4Re.test(entry) || ipv6Re.test(entry);
    if (!valid) {
      // eslint-disable-next-line no-console
      console.warn(`[config] Ignoring invalid TRUSTED_PROXIES entry: "${entry}"`);
    }
    return valid;
  });

  if (trustedProxies.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[config] No valid TRUSTED_PROXIES entries — falling back to loopback only');
    trustedProxies.push('127.0.0.1', '::1');
  }

  const fastify = Fastify({
    logger: !options.skipSecretValidation ? true : false,
    trustProxy: trustedProxies,
    // SECURITY: Bound idle and slow-header connection times to prevent resource exhaustion.
    // connectionTimeout covers the TCP handshake + first byte; requestTimeout covers
    // the full request lifecycle (headers + body). SSE routes override reply timeout
    // individually since they stream indefinitely.
    connectionTimeout: 10_000,  // 10 s to establish connection
    requestTimeout: 30_000,     // 30 s for a complete request (body included)
  });

  // Helmet — security headers
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Allow same-site cross-origin resource loading (e.g. conduit.example.com ↔ api.conduit.example.com).
    // 'same-site' is sufficient when both share the same registrable domain.
    // 'cross-origin' would be overly permissive — the API only serves JSON, not embeddable resources.
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Allow magic link redirects/popups to communicate back into the SPA
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // Remove deprecated X-XSS-Protection header
    xXssProtection: false,
    // Hide X-Powered-By
    hidePoweredBy: true,
  });

  // CORS — allow the web app origin plus Capacitor Android origins
  const allowedOrigins = [config.appUrl, ...config.capacitorOrigins];
  await fastify.register(fastifyCors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // Cookies
  await fastify.register(fastifyCookie);

  // Capacitor Android injects Content-Type: application/x-www-form-urlencoded on
  // ALL requests including GETs with no body. Without this parser Fastify returns
  // 415 Unsupported Media Type on every GET from the Android app (metrics, sessions, etc).
  // We register a no-op parser that accepts the header and returns an empty object,
  // which is correct since GET routes never read a body anyway.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, _body, done) => done(null, {}),
  );

  // Global rate limit — generous to accommodate SSE reconnects, polling, and
  // normal dashboard usage. The /auth/refresh endpoint has its own dedicated
  // rate limit (60/min) registered at the route level instead of being exempt.
  // 600/min = 10 req/s sustained, enough for aggressive multi-tab usage.
  await fastify.register(fastifyRateLimit, {
    max: 600,
    timeWindow: '1 minute',
  });

  // Remove Server header on every response.
  // Also ensure CORS headers are present on ALL responses, including rate-limit
  // 429s that @fastify/rate-limit emits before the CORS plugin can add them.
  // Without this the browser sees a CORS error instead of a 429 and the
  // frontend can't distinguish a rate-limit from a network failure.
  fastify.addHook('onSend', async (request, reply) => {
    reply.removeHeader('Server');
    reply.removeHeader('X-Powered-By');

    // SECURITY: Prevent browsers from caching API responses containing auth tokens,
    // session data, or other sensitive information. SSE streams set their own headers.
    const contentType = reply.getHeader('content-type') as string | undefined;
    const isSSE = contentType?.includes('text/event-stream');
    if (!isSSE) {
      reply.header('Cache-Control', 'no-store');
    }

    const origin = request.headers['origin'];
    if (origin && !reply.hasHeader('access-control-allow-origin')) {
      // Only reflect the origin if it matches an allowed origin.
      // Never use wildcard '*' here because we send credentials.
      if (allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }
    }
  });

  // Custom error handler — prevent stack traces and internal paths from leaking
  // to clients. Full details are logged server-side for debugging.
  fastify.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Log full error internally (includes stack trace, request details, etc.)
    request.log.error({ err: error, statusCode }, 'Request error');

    // Validation errors from Fastify/Zod — safe to surface
    if (statusCode === 400 && error.validation) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.message,
        statusCode: 400,
      });
    }

    // Rate limit errors — surface the retry-after info
    if (statusCode === 429) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        statusCode: 429,
      });
    }

    // Client errors (4xx) — safe to surface the message
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: error.name ?? 'Error',
        message: error.message,
        statusCode,
      });
    }

    // Server errors (5xx) — sanitize, never expose internals
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred.',
      statusCode: 500,
    });
  });

  // Initialize database
  const db = initializeDatabase(options.dbPath);
  fastify.decorate('db', db);

  // Initialize metrics aggregator (batched counter writes every 60s)
  const metricsAggregator = new MetricsAggregator(db);
  metricsAggregator.start();
  fastify.decorate('metricsAggregator', metricsAggregator);

  // Pre-warm model pricing cache (fire-and-forget — never blocks startup)
  pricingService.warmUp();

  // Close DB on shutdown
  fastify.addHook('onClose', async () => {
    metricsAggregator.stop();
    stopCleanupJob();
    db.close();
  });

  // Start periodic DB cleanup (expired tokens, old events, etc.)
  startCleanupJob(db, fastify.log);

  // Android App Links verification — must be served at the root domain with no prefix.
  // Returns 404 if ASSETLINKS_FINGERPRINT is not configured (opt-in).
  fastify.get('/.well-known/assetlinks.json', async (_request, reply) => {
    if (!config.assetlinksFingerprint) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.code(200)
      .header('Content-Type', 'application/json')
      .send([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.conduit.app',
          sha256_cert_fingerprints: [config.assetlinksFingerprint],
        },
      }]);
  });

  // Register routes
  await fastify.register(async (api) => {
    // Health check
    api.get('/health', async (_request, reply) => {
      return reply.code(200).send({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Auth routes — /auth/*
    await api.register(authRoutes, { prefix: '/auth' });

    // OAuth routes — /auth/oauth/* (GitHub + GitLab login, alongside magic link)
    await api.register(oauthRoutes, { prefix: '/auth/oauth' });

    // Protected routes with CSRF
    await api.register(async (protectedApi) => {
      protectedApi.addHook('preHandler', requireCsrf);

      // Onboarding — /onboarding
      await protectedApi.register(onboardingRoutes, { prefix: '/onboarding' });

      // Sessions — /sessions/*
      await protectedApi.register(sessionRoutes, { prefix: '/sessions' });

      // Config — /config/*
      await protectedApi.register(configRoutes, { prefix: '/config' });

      // Metrics — /metrics/*
      await protectedApi.register(metricsRoutes, { prefix: '/metrics' });

      // Instances — /instances/*
      await protectedApi.register(instanceRoutes, { prefix: '/instances' });

      // Models — /models (read model list per instance)
      await protectedApi.register(modelsRoutes, { prefix: '/models' });
    });

    // SSE events — /events (no CSRF for GET)
    await api.register(eventRoutes, { prefix: '/events' });

    // Hooks — /hooks (own auth via bearer + HMAC)
    await api.register(hookRoutes, { prefix: '/hooks' });

    // Instance registration — /instances/register (own auth via hook token, no CSRF)
    await api.register(instanceRegisterRoute, { prefix: '/instances/register' });

    // Instance deregistration — /instances/deregister (own auth via hook token, no CSRF)
    await api.register(instanceDeregisterRoute, { prefix: '/instances/deregister' });

    // Instance heartbeat — /instances/heartbeat (own auth via hook token, no CSRF)
    await api.register(instanceHeartbeatRoute, { prefix: '/instances/heartbeat' });

    // Config agent endpoints — /config/pending and /config/ack (own auth via bearer token)
    await api.register(configAgentRoutes, { prefix: '/config' });

    // Prompt relay — /prompts/* (own auth via hook token, no CSRF)
    await api.register(promptRelayRoutes, { prefix: '/prompts' });
  });

  return fastify;
}
