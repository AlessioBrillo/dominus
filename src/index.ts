import express from 'express';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { openDatabase, runMigrations } from './db/index.js';
import {
  CandidateRepository,
  ScoringRepository,
  PortfolioRepository,
  TrademarkRepository,
  OutcomeRepository,
} from './db/index.js';
import { NodeDnsProvider } from './providers/dns/index.js';
import { PublicRdapProvider } from './providers/rdap/index.js';
import { NodeWhoisProviderWithIanaFallback } from './providers/whois/index.js';
import { UsptoCasesProvider, EuipoProvider } from './providers/trademark/index.js';
import { ManualKeywordProvider } from './providers/keyword/index.js';
import { ManualCompsProvider } from './providers/comps/index.js';
import { ScoringEngine, loadWeights } from './scoring/index.js';
import { TrademarkGate } from './trademark/index.js';
import {
  PipelineOrchestrator,
  CandidateGenerationStage,
  DnsPreFilterStage,
  RdapConfirmationStage,
  ScoringStage,
  TrademarkGateStage,
} from './pipeline/index.js';
import { PortfolioManager, RenewalAlertEngine } from './portfolio/index.js';
import { PortfolioRescoreService } from './portfolio/portfolio-rescore-service.js';
import { RenewalAlertRepository } from './db/index.js';
import { buildNotifiers } from './notifiers/index.js';
import { SchedulerService } from './scheduler/index.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
} from './app/index.js';
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
  errorHandler,
  createRequestLogger,
} from './api/index.js';
import { PipelineRunsRepository } from './db/repositories/pipeline-runs-repository.js';

const config = loadConfig();
const logger = getLogger();

const db = openDatabase(config.DATABASE_PATH);
runMigrations(db);
warnEuipoIfMissing(config);

const candidateRepo = new CandidateRepository(db);
const scoringRepo = new ScoringRepository(db);
const portfolioRepo = new PortfolioRepository(db);
const trademarkRepo = new TrademarkRepository(db);
const outcomeRepo = new OutcomeRepository(db);

const keywordProvider = new ManualKeywordProvider(config.KEYWORD_DATA_PATH);
const compsProvider = new ManualCompsProvider(config.COMPS_DATA_PATH);
const engine = new ScoringEngine(
  keywordProvider,
  compsProvider,
  loadWeights(config.SCORING_WEIGHTS_OVERRIDE),
  config.BUY_MAX_ABSOLUTE_CAP,
  config.SCORING_RECOMMEND_THRESHOLD,
);

const trademarkGate = new TrademarkGate(
  new CachedTrademarkProvider(
    new RetryingTrademarkProvider(new UsptoCasesProvider({ searchUrl: config.USPTO_SEARCH_URL })),
    trademarkRepo,
    'USPTO',
    config.TM_CACHE_TTL_DAYS,
  ),
  new CachedTrademarkProvider(
    new RetryingTrademarkProvider(
      new EuipoProvider({
        clientId: config.EUIPO_CLIENT_ID,
        clientSecret: config.EUIPO_CLIENT_SECRET,
        authUrl: config.EUIPO_AUTH_URL,
        apiUrl: config.EUIPO_API_URL,
      }),
    ),
    trademarkRepo,
    'EUIPO',
    config.TM_CACHE_TTL_DAYS,
  ),
);

const whoisProvider = new NodeWhoisProviderWithIanaFallback({
  timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
});

const orchestrator = new PipelineOrchestrator(
  new CandidateGenerationStage(),
  new DnsPreFilterStage(new NodeDnsProvider()),
  new RdapConfirmationStage(new PublicRdapProvider(), whoisProvider),
  new ScoringStage(engine),
  new TrademarkGateStage(trademarkGate),
);

const runService = new PipelineRunService(db, orchestrator, candidateRepo, scoringRepo);

const portfolioManager = new PortfolioManager(
  portfolioRepo,
  config.DROP_SCORE_THRESHOLD,
  config.DROP_RENEWAL_HORIZON_DAYS,
);
portfolioManager.setRescoreService(
  new PortfolioRescoreService(engine, trademarkGate, candidateRepo, scoringRepo),
);

const alertRepo = new RenewalAlertRepository(db);
const notifiersAlert = buildNotifiers(config);
const alertEngine = new RenewalAlertEngine(portfolioRepo, alertRepo, config, notifiersAlert);

let scheduler: SchedulerService | undefined;
if (config.SCHEDULER_ENABLED) {
  scheduler = new SchedulerService(config, alertEngine);
  scheduler.start();
}

const app = express();

// Security headers (Principle 4: cost includes safety — zero-effort hardening).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

app.use(express.json());
app.use(createRequestLogger(logger));

app.use('/api/health', createHealthRouter());
app.use('/api/score', createScoreRouter(engine, trademarkGate));
app.use(
  '/api/backtest',
  createBacktestRouter(db, outcomeRepo, loadWeights(config.SCORING_WEIGHTS_OVERRIDE)),
);
app.use('/api/providers', createProvidersRouter(config));
app.use('/api/outcomes', createOutcomesRouter(outcomeRepo));
app.use('/api/candidates', createCandidatesRouter(runService, candidateRepo));
app.use('/api/portfolio', createPortfolioRouter(portfolioManager, outcomeRepo));
app.use(
  '/api/runs',
  createRunsRouter(new PipelineRunsRepository(db), candidateRepo, scoringRepo, db),
);
app.use('/api/alerts', createAlertsRouter({ alertRepo, alertEngine }));
if (scheduler) {
  app.use('/api/scheduler', createSchedulerRouter(scheduler));
}

app.use(errorHandler);

app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST }, 'DOMINUS server started');
});
