import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { createDependencies } from './app/composition-root.js';
import { closeDatabase } from './db/database.js';
import { EnvApiKeyProvider } from './providers/auth/env-api-key-provider.js';
import { createAuthMiddleware } from './api/middleware/auth.js';
import { securityHeaders } from './api/middleware/security-headers.js';
import { requestTimeout } from './api/middleware/timeout.js';
import {
  createCandidatesRouter,
  createPortfolioRouter,
  createRunsRouter,
  createHealthRouter,
  createScoreRouter,
  createBacktestRouter,
  createProvidersRouter,
  createOutcomesRouter,
  createAuthRouter,
  createAlertsRouter,
  createSchedulerRouter,
  createWatchlistRouter,
  createPurchaseRouter,
  createBidsRouter,
  createReportRouter,
  createMetricsRouter,
  createAnalyticsRouter,
  createListingsRouter,
  createOnboardingRouter,
  createDocsRouter,
  createPublicRouter,
  errorHandler,
  createRequestLogger,
} from './api/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();
  const deps = await createDependencies(config);

  const authProvider = new EnvApiKeyProvider(config.API_KEYS, config.FILE_API_KEYS);
  if (!authProvider.isActive) {
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
  const authMiddleware = createAuthMiddleware(authProvider);

  const app = express();

  const corsOrigins = config.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (corsOrigins.includes('*')) {
    logger.warn(
      'CORS is configured with wildcard origin (*). This allows any website to call the API. ' +
        'Restrict CORS_ORIGIN to specific origins in production.',
    );
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

  app.use(securityHeaders);

  if (config.REQUEST_TIMEOUT_MS > 0) {
    app.use(requestTimeout(config.REQUEST_TIMEOUT_MS));
  }

  app.use(express.json({ limit: '100kb' }));
  app.use(createRequestLogger(logger));

  app.use('/public', createPublicRouter(deps.provider, deps.engine, deps.trademarkGate));

  app.use('/api/v1/docs', createDocsRouter());
  app.use('/api/health', createHealthRouter(deps.healthCheck, deps.metrics));
  app.use('/api/v1/health', createHealthRouter(deps.healthCheck, deps.metrics));
  app.use('/api/v1/metrics', createMetricsRouter(deps.metricsRepo, deps.metrics));
  app.use('/api/v1/auth', createAuthRouter(authProvider));

  const protectedRouter = express.Router();
  protectedRouter.use(authMiddleware);
  protectedRouter.use(
    '/backtest',
    createBacktestRouter(deps.provider, deps.outcomeRepo, deps.currentWeights, deps.autoTuner),
  );
  protectedRouter.use('/providers', createProvidersRouter(deps.config));
  protectedRouter.use('/outcomes', createOutcomesRouter(deps.outcomeRepo));
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
  protectedRouter.use('/report', createReportRouter(deps.reportService));
  protectedRouter.use('/analytics', createAnalyticsRouter(deps.accuracyAnalyzer, deps.pnlService));
  protectedRouter.use('/listings', createListingsRouter(deps.listingManager));
  app.use('/api/v1', protectedRouter);

  // ── SPA catch-all with base path isolation ─────────────────────────
  const frontendDir = resolve(process.cwd(), config.FRONTEND_DIST_PATH);
  const spaPattern = config.FRONTEND_BASE_PATH ? `${config.FRONTEND_BASE_PATH}/*` : '*';

  if (existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
    app.get(spaPattern, (req, res) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
        return;
      }
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

  function shutdown(signal: string): void {
    logger.info({ signal }, 'Shutdown signal received — draining connections');

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    server.close(() => {
      if (deps.scheduler) {
        deps.scheduler.stop();
        logger.info('Scheduler stopped');
      }
      closeDatabase();
      logger.info('Database closed');
      process.exit(0);
    });

    const drainMs = 5_000;
    const graceMs = 25_000;
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }, drainMs).unref();

    const forceExitMs = drainMs + graceMs;
    setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, forceExitMs).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
