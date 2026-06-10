import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { createDependencies } from './app/composition-root.js';
import { EnvApiKeyProvider } from './providers/auth/env-api-key-provider.js';
import { createAuthMiddleware } from './api/middleware/auth.js';
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
  createAlertsRouter,
  createSchedulerRouter,
  createWatchlistRouter,
  createPurchaseRouter,
  errorHandler,
  createRequestLogger,
} from './api/index.js';

const config = loadConfig();
const logger = getLogger();
const deps = createDependencies(config);

const authProvider = new EnvApiKeyProvider(config.API_KEYS);
if (!authProvider.isActive) {
  logger.warn('API authentication is DISABLED. Set API_KEYS env var to enable.');
}
const authMiddleware = createAuthMiddleware(authProvider);

const app = express();

app.use(cors({ origin: config.CORS_ORIGIN }));

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

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

if (config.REQUEST_TIMEOUT_MS > 0) {
  app.use(requestTimeout(config.REQUEST_TIMEOUT_MS));
}

app.use(express.json({ limit: '100kb' }));
app.use(createRequestLogger(logger));

app.use('/api/health', createHealthRouter(deps.healthCheck));

const protectedRouter = express.Router();
protectedRouter.use(authMiddleware);
protectedRouter.use(
  '/backtest',
  createBacktestRouter(deps.db, deps.outcomeRepo, deps.currentWeights, deps.autoTuner),
);
protectedRouter.use('/providers', createProvidersRouter(deps.config));
protectedRouter.use('/outcomes', createOutcomesRouter(deps.outcomeRepo));
protectedRouter.use('/candidates', createCandidatesRouter(deps.runService, deps.candidateRepo));
protectedRouter.use('/portfolio', createPortfolioRouter(deps.portfolioManager, deps.outcomeRepo));
protectedRouter.use(
  '/runs',
  createRunsRouter(deps.pipelineRunsRepo, deps.candidateRepo, deps.scoringRepo, deps.db),
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
protectedRouter.use('/purchase', createPurchaseRouter(deps.purchaseService));
app.use('/api', protectedRouter);

// ── SPA catch-all with base path isolation ─────────────────────────
// The SPA middleware is mounted AFTER all API routes to prevent path
// conflicts. The catch-all only matches non-API paths. When
// FRONTEND_BASE_PATH is set (e.g. "/dominus"), the catch-all only
// fires for paths under that prefix — enabling deployment behind a
// reverse proxy that rewrites the prefix away from upstream.
const frontendDir = resolve(process.cwd(), config.FRONTEND_DIST_PATH);
const spaPattern = config.FRONTEND_BASE_PATH ? `${config.FRONTEND_BASE_PATH}/*` : '*';

if (existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
  app.get(spaPattern, (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found' } });
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

app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST }, 'DOMINUS server started');
});
