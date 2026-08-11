// SPDX-License-Identifier: AGPL-3.0-only
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { createDependencies } from './app/composition-root.js';
import { closeDatabase } from './db/database.js';
import { JobQueueRepository } from './db/repositories/job-queue-repository.js';
import type { PublicRouterOptions } from './api/index.js';
import { createAuthMiddleware } from './api/middleware/auth.js';
import { createUsageEnforcementMiddleware } from './api/middleware/usage-enforcement.js';
import { isMultiTenantAuth } from './app/auth-factory.js';
import { securityHeaders } from './api/middleware/security-headers.js';
import { requestTimeout } from './api/middleware/timeout.js';
import { serverTimeoutConfig } from './utils/server-timeouts.js';
import {
  createUsageRouter,
  createBillingRouter,
  createAdminRouter,
  createCandidatesRouter,
  createPortfolioRouter,
  createRunsRouter,
  createHealthRouter,
  createScoreRouter,
  createBacktestRouter,
  createProvidersRouter,
  createOutcomesRouter,
  createAuthRouter,
  createKeyManagementRouter,
  createAlertsRouter,
  createSchedulerRouter,
  createWatchlistRouter,
  createPurchaseRouter,
  createBidsRouter,
  createFunnelRouter,
  createReportRouter,
  createMetricsRouter,
  createAnalyticsRouter,
  createListingsRouter,
  createOnboardingRouter,
  createDocsRouter,
  createWorkerRouter,
  createPublicRouter,
  createRobotsTxtHandler,
  errorHandler,
  createRequestLogger,
  responseCache,
} from './api/index.js';

/** Build the public router options, omitting the URL when it is unset. */
function publicAppUrlOption(config: {
  PUBLIC_APP_URL?: string | undefined;
  PUBLIC_ALLOWED_HOSTS?: string | undefined;
  PUBLIC_RATE_LIMIT_WINDOW_MS: number;
  PUBLIC_RATE_LIMIT_MAX: number;
  PER_DOMAIN_RATE_LIMIT_WINDOW_MS: number;
  PER_DOMAIN_RATE_LIMIT_MAX: number;
  POST_RATE_LIMIT_WINDOW_MS: number;
  POST_RATE_LIMIT_MAX: number;
  POST_BODY_MAX_BYTES: number;
}): PublicRouterOptions {
  return {
    ...(config.PUBLIC_APP_URL ? { publicAppUrl: config.PUBLIC_APP_URL } : {}),
    ...(config.PUBLIC_ALLOWED_HOSTS
      ? {
          allowedHosts: config.PUBLIC_ALLOWED_HOSTS.split(',')
            .map((h) => h.trim())
            .filter(Boolean),
        }
      : {}),
    rateLimits: {
      publicWindowMs: config.PUBLIC_RATE_LIMIT_WINDOW_MS,
      publicMax: config.PUBLIC_RATE_LIMIT_MAX,
      perDomainWindowMs: config.PER_DOMAIN_RATE_LIMIT_WINDOW_MS,
      perDomainMax: config.PER_DOMAIN_RATE_LIMIT_MAX,
      postWindowMs: config.POST_RATE_LIMIT_WINDOW_MS,
      postMax: config.POST_RATE_LIMIT_MAX,
      postBodyMaxBytes: config.POST_BODY_MAX_BYTES,
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();
  const deps = await createDependencies(config);

  if (!deps.authProvider.isActive) {
    if (config.HOST === '0.0.0.0' || config.HOST === '::') {
      logger.fatal(
        'FATAL: API authentication is DISABLED but server is bound to 0.0.0.0 (all interfaces). ' +
          'Set API_KEYS env var to enable authentication, or bind to 127.0.0.1 for local-only access. ' +
          'This is a security risk — startup aborted.',
      );
      process.exit(1);
    } else {
      logger.warn('API authentication is DISABLED. Set API_KEYS env var to enable.');
    }
  }
  const authMiddleware = createAuthMiddleware(deps.authProvider, deps.provider, {
    requireTenant: isMultiTenantAuth(config),
  });

  if (
    !config.PUBLIC_APP_URL &&
    !config.PUBLIC_ALLOWED_HOSTS &&
    (config.HOST === '0.0.0.0' || config.HOST === '::')
  ) {
    logger.warn(
      'PUBLIC_APP_URL (or PUBLIC_ALLOWED_HOSTS) is not set while the server is bound to 0.0.0.0. ' +
        'Public canonical/OG/sitemap URLs will mirror the request Host header — set ' +
        'PUBLIC_APP_URL to your public origin to prevent canonical-URL cache poisoning.',
    );
  }

  const app = express();

  // Trust the first reverse proxy for correct req.ip, rate limiting, and logging.
  // Behind K8s nginx-ingress, Cloudflare, or Traefik, the proxy IP is the first
  // hop and the client IP is in X-Forwarded-For. Without this, all rate limiting
  // keys on the same proxy IP — a single bucket for all users.
  app.set('trust proxy', config.TRUST_PROXY_DEPTH);

  const corsOrigins = config.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (corsOrigins.includes('*') && (config.HOST === '0.0.0.0' || config.HOST === '::')) {
    logger.fatal(
      'FATAL: CORS_ORIGIN is wildcard (*) but server is bound to 0.0.0.0 (all interfaces). ' +
        'This allows any website to call the API. Restrict CORS_ORIGIN to specific origins, ' +
        'or set HOST to 127.0.0.1 for local-only access. Startup aborted.',
    );
    process.exit(1);
  }

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );

  app.use(securityHeaders);

  if (config.REQUEST_TIMEOUT_MS > 0) {
    app.use(requestTimeout(config.REQUEST_TIMEOUT_MS));
  }

  // Stripe webhook requires raw body for signature verification.
  // Mounted before express.json() to preserve the raw payload.
  if (deps.billingService.isConfigured) {
    app.post(
      '/api/v1/billing/webhook',
      express.raw({ type: 'application/json' }),
      async (req, res) => {
        try {
          const sig = req.headers['stripe-signature'] as string;
          if (!sig) {
            res.status(400).json({ error: 'Missing stripe-signature header' });
            return;
          }
          await deps.billingService.handleWebhookEvent(req.body as Buffer, sig);
          res.json({ received: true });
        } catch (err) {
          logger.error({ err }, 'Stripe webhook error');
          res.status(400).json({ error: 'Webhook signature verification failed' });
        }
      },
    );
  }

  app.use(express.json({ limit: '100kb' }));
  app.use(createRequestLogger(logger));

  // Mount public static assets (CSS, images) before routes so they are
  // served with CSP 'self' scope and no auth required.
  const publicStaticDir = resolve(process.cwd(), 'public/static');
  if (existsSync(publicStaticDir)) {
    app.use('/public/static', express.static(publicStaticDir, { maxAge: '1d' }));
  }

  app.use(
    '/public',
    createPublicRouter(deps.anonScoringService, deps.redisClient, publicAppUrlOption(config)),
  );

  // Site-root robots.txt (crawlers fetch '/robots.txt'). The handler is
  // per-origin and, like the public namespace, must be reachable without
  // auth and before the SPA catch-all. The Sitemap directive points at the
  // /public/sitemap.xml route.
  app.get('/robots.txt', createRobotsTxtHandler(publicAppUrlOption(config)));

  app.use('/api/v1/docs', createDocsRouter());
  app.use('/api/health', createHealthRouter(deps.healthCheck, deps.metrics));
  app.use('/api/v1/health', createHealthRouter(deps.healthCheck, deps.metrics));
  const metricsRouterOptions =
    config.METRICS_TOKEN !== undefined ? { token: config.METRICS_TOKEN } : {};
  app.use(
    '/api/v1/metrics',
    createMetricsRouter(
      deps.metricsRepo,
      deps.metrics,
      new JobQueueRepository(deps.provider),
      metricsRouterOptions,
    ),
  );

  // Auth routes: tight per-IP rate limit (separate from global API rate limit)
  // This limits brute-force attempts on the login endpoint.
  // The auth middleware also enforces per-IP failure-rate limiting (10 failures/60s).
  if (config.RATE_LIMIT_MAX > 0) {
    app.use(
      '/api/v1/auth',
      rateLimit({
        windowMs: Math.min(config.RATE_LIMIT_WINDOW_MS, 60_000),
        max: Math.min(config.RATE_LIMIT_MAX, 30),
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many authentication attempts. Try again later.',
          },
        },
      }),
    );
  }
  app.use('/api/v1/auth', createAuthRouter(deps.authProvider));

  // Global per-IP rate limit for all remaining API routes (protects against
  // request floods and resource exhaustion). Applied after auth to separate
  // auth-throttling from general-API throttling.
  if (config.RATE_LIMIT_MAX > 0) {
    app.use(
      rateLimit({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
        },
      }),
    );
  }

  const protectedRouter = express.Router();
  protectedRouter.use(authMiddleware);
  // Plan usage enforcement: records one api_call per request and rejects
  // with 429 once the tenant's monthly plan limit is exhausted. No-op unless
  // USAGE_ENFORCEMENT_ENABLED=true (see middleware docs). Mounted after auth
  // because it keys on req.tenantId.
  protectedRouter.use(
    createUsageEnforcementMiddleware(deps.usageService, config.USAGE_ENFORCEMENT_ENABLED),
  );
  protectedRouter.use(responseCache(60));

  // Per-token rate limit for authenticated API calls. This prevents a single
  // API key holder from overwhelming the backend or exhausting the global
  // per-IP rate limit. Key is derived from the authenticated API key hash.
  if (config.RATE_LIMIT_MAX > 0) {
    protectedRouter.use(
      rateLimit({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.RATE_LIMIT_MAX * 2,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => {
          const header = req.headers['authorization'] ?? 'unknown';
          return `token:${header}`;
        },
        message: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests for this API key. Try again later.',
          },
        },
      }),
    );
  }

  protectedRouter.use(
    '/backtest',
    createBacktestRouter(deps.provider, deps.outcomeRepo, deps.currentWeights, deps.autoTuner),
  );
  protectedRouter.use('/providers', createProvidersRouter(deps.config));
  protectedRouter.use(
    '/outcomes',
    createOutcomesRouter(deps.outcomeRepo, (domain, salePriceEur) => {
      deps.jobQueueService.enqueueBacktestBuild().catch((err) => {
        logger.error({ err, domain, salePriceEur }, 'Failed to enqueue backtest after sale');
      });
    }),
  );
  protectedRouter.use('/candidates', createCandidatesRouter(deps.runService, deps.candidateRepo));
  protectedRouter.use('/portfolio', createPortfolioRouter(deps.portfolioManager, deps.outcomeRepo));
  protectedRouter.use(
    '/runs',
    createRunsRouter(
      deps.pipelineRunsRepo,
      deps.candidateRepo,
      deps.scoringRepo,
      deps.db,
      deps.progressService,
      deps.runService,
      deps.jobQueueService,
    ),
  );
  protectedRouter.use(
    '/alerts',
    createAlertsRouter({ alertRepo: deps.alertRepo, alertEngine: deps.alertEngine }),
  );
  if (deps.scheduler) {
    protectedRouter.use('/scheduler', createSchedulerRouter(deps.scheduler));
  }
  protectedRouter.use('/watchlist', createWatchlistRouter(deps.watchlistService));
  protectedRouter.use('/score', createScoreRouter(deps.engine, deps.trademarkGate));
  protectedRouter.use(
    '/onboarding',
    createOnboardingRouter(deps.provider, deps.engine, deps.trademarkGate, deps.portfolioManager),
  );
  protectedRouter.use('/purchase', createPurchaseRouter(deps.purchaseService));
  protectedRouter.use('/bids', createBidsRouter(deps.acquisitionService));
  protectedRouter.use('/keys', createKeyManagementRouter(deps.authProvider, deps.apiKeyRepo));
  protectedRouter.use('/usage', createUsageRouter(deps.usageService));
  protectedRouter.use('/billing', createBillingRouter(deps.config, deps.billingService));
  protectedRouter.use('/admin', createAdminRouter(deps.adminService));
  protectedRouter.use('/funnel', createFunnelRouter(deps.funnelService));
  protectedRouter.use('/report', createReportRouter(deps.reportService));
  protectedRouter.use('/analytics', createAnalyticsRouter(deps.accuracyAnalyzer, deps.pnlService));
  protectedRouter.use('/listings', createListingsRouter(deps.listingManager));
  if (deps.worker) {
    protectedRouter.use('/system', createWorkerRouter(deps.worker, deps.jobQueueService));
  }
  app.use('/api/v1', protectedRouter);

  // ── SPA catch-all with base path isolation ─────────────────────────
  // Per ADR-0030 (Option B): the SPA catch-all is mounted AFTER the
  // /api/v1 and /public routers. A middleware gate explicitly rejects
  // any /api/ or /public/ path that reaches the catch-all (unmatched
  // route) rather than serving the SPA for them. This provides
  // router-level isolation: the auth middleware never executes for
  // /public/* requests, and the SPA never catches /api/ or /public/
  // paths that have no matching route.
  const frontendDir = resolve(process.cwd(), config.FRONTEND_DIST_PATH);
  // path-to-regexp v8 (Express 5) rejects the bare '*' wildcard; the SPA
  // catch-all must use the named wildcard '/*splat'. A bare '*' crashed the
  // production image at boot whenever the frontend dist was present.
  const spaPattern = config.FRONTEND_BASE_PATH ? `${config.FRONTEND_BASE_PATH}/*splat` : '/*splat';

  const rejectApiAndPublic: express.RequestHandler = (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      return;
    }
    next();
  };

  if (existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
    app.get(spaPattern, rejectApiAndPublic, (_req, res) => {
      res.sendFile(join(frontendDir, 'index.html'));
    });
    logger.info(
      { dir: frontendDir, basePath: config.FRONTEND_BASE_PATH || '/' },
      'Serving SPA frontend from disk',
    );
  } else {
    logger.info(
      { dir: frontendDir },
      'Frontend dist not found — API-only mode (run `cd frontend && npm run build` to enable)',
    );
  }

  app.use(errorHandler);

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT, host: config.HOST }, 'DOMINUS server started');
    const warmupMs = config.SCHEDULER_WARMUP_MS;
    if (deps.scheduler) {
      setTimeout(() => {
        deps.scheduler!.start();
        logger.info({ warmupMs }, 'Background scheduler started after warmup');
      }, warmupMs);
    }
  });

  // Explicit socket-level timeouts. Node defaults (keepAliveTimeout 5s,
  // headersTimeout 60s, requestTimeout 300s) are either too short for edge
  // connection reuse (Cloudflare/ALB idle ~60s) or too lax for slowloris.
  // See src/utils/server-timeouts.ts for the tuning rationale.
  const timeouts = serverTimeoutConfig(config.REQUEST_TIMEOUT_MS);
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
  logger.info(
    {
      keepAliveTimeoutMs: timeouts.keepAliveTimeoutMs,
      headersTimeoutMs: timeouts.headersTimeoutMs,
    },
    'HTTP server timeouts configured',
  );

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutdown signal received — draining connections');

    const drainMs = 5_000;
    const graceMs = 25_000;
    const forceExitMs = drainMs + graceMs;

    const forceTimer = setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      process.exit(1);
    }, forceExitMs).unref();

    try {
      // Step 1: Stop accepting new connections on the HTTP server
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }

      // Step 2: Stop the job worker first — it may have active pipeline runs.
      // The worker abort controller will propagate to PipelineRunService via
      // the AbortSignal in PipelineRunOptions. Wait for all active jobs to
      // complete or abort (gracefulShutdownTimeoutMs default: 30s).
      if (deps.worker) {
        logger.info('Stopping job worker...');
        await deps.worker.stop();
        logger.info('Job worker stopped');
      }

      // Step 3: Stop the background scheduler
      if (deps.scheduler) {
        deps.scheduler.stop();
        logger.info('Scheduler stopped');
      }

      // Step 4: Close the HTTP server (drain active requests)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        setTimeout(() => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        }, drainMs).unref();
      });
      logger.info('HTTP server closed');

      // Step 5: Close the Redis connection, if one was opened
      if (deps.redisClient) {
        await deps.redisClient.shutdown();
      }

      // Step 5b: Close DNS DoT connection pools (rejects queued queries)
      if (deps.dnsProvider && typeof deps.dnsProvider.dispose === 'function') {
        deps.dnsProvider.dispose();
        logger.info('DNS provider disposed');
      }

      // Step 5c: Stop the public score view-count flush timer so a pending
      // in-memory flush can never fire after the database is closed (or keep
      // the process alive after the HTTP server has drained).
      deps.anonScoringService.dispose();
      logger.info('Anon scoring service disposed');

      // Step 6: Close the database provider (SqliteProvider or PostgresAdapter).
      // This tears down the connection pool managed by the provider.
      if (deps.provider) {
        await deps.provider.close();
      }

      // Step 7: Close the bulk-write provider (separate WAL connection for SQLite,
      // or secondary pg.Pool for PostgreSQL). Must happen after the main provider
      // to avoid orphaned write transactions.
      if (deps.bulkWriteProvider) {
        await deps.bulkWriteProvider.close();
      }

      // Step 8: Close the legacy singleton database connection (used by CLI
      // maintenance commands that bypass the provider abstraction).
      closeDatabase();
      logger.info('Database closed');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
