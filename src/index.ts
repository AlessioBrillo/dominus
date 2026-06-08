import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { createDependencies } from './app/composition-root.js';
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
  errorHandler,
  createRequestLogger,
} from './api/index.js';

const config = loadConfig();
const logger = getLogger();
const deps = createDependencies(config);

const app = express();

app.use(cors({ origin: config.CORS_ORIGIN }));

if (config.RATE_LIMIT_MAX > 0) {
  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
    }),
  );
}

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(createRequestLogger(logger));

app.use('/api/health', createHealthRouter());
app.use('/api/score', createScoreRouter(deps.engine, deps.trademarkGate));
app.use(
  '/api/backtest',
  createBacktestRouter(deps.db, deps.outcomeRepo, deps.currentWeights),
);
app.use('/api/providers', createProvidersRouter(deps.config));
app.use('/api/outcomes', createOutcomesRouter(deps.outcomeRepo));
app.use('/api/candidates', createCandidatesRouter(deps.runService, deps.candidateRepo));
app.use('/api/portfolio', createPortfolioRouter(deps.portfolioManager, deps.outcomeRepo));
app.use('/api/runs', createRunsRouter(deps.pipelineRunsRepo, deps.candidateRepo, deps.scoringRepo, deps.db));
app.use('/api/alerts', createAlertsRouter({ alertRepo: deps.alertRepo, alertEngine: deps.alertEngine }));
if (deps.scheduler) {
  app.use('/api/scheduler', createSchedulerRouter(deps.scheduler));
}

app.use('/api/watchlist', createWatchlistRouter(deps.watchlistService));

app.use(errorHandler);

app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST }, 'DOMINUS server started');
});
