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
import { PortfolioManager } from './portfolio/index.js';
import { PortfolioRescoreService } from './portfolio/portfolio-rescore-service.js';
import { PipelineRunService, CachedTrademarkProvider } from './app/index.js';
import {
  createCandidatesRouter,
  createPortfolioRouter,
  errorHandler,
  createRequestLogger,
} from './api/index.js';

const config = loadConfig();
const logger = getLogger();

const db = openDatabase(config.DATABASE_PATH);
runMigrations(db);

const candidateRepo = new CandidateRepository(db);
const scoringRepo = new ScoringRepository(db);
const portfolioRepo = new PortfolioRepository(db);
const trademarkRepo = new TrademarkRepository(db);
const outcomeRepo = new OutcomeRepository(db);

const keywordProvider = new ManualKeywordProvider(config.KEYWORD_DATA_PATH);
const compsProvider = new ManualCompsProvider(config.COMPS_DATA_PATH);
const engine = new ScoringEngine(keywordProvider, compsProvider, loadWeights(config.SCORING_WEIGHTS_OVERRIDE));

const trademarkGate = new TrademarkGate(
  new CachedTrademarkProvider(
    new UsptoCasesProvider({ searchUrl: config.USPTO_SEARCH_URL }),
    trademarkRepo,
    'USPTO',
    config.TM_CACHE_TTL_DAYS,
  ),
  new CachedTrademarkProvider(
    new EuipoProvider({
      clientId: config.EUIPO_CLIENT_ID,
      clientSecret: config.EUIPO_CLIENT_SECRET,
      authUrl: config.EUIPO_AUTH_URL,
      apiUrl: config.EUIPO_API_URL,
    }),
    trademarkRepo,
    'EUIPO',
    config.TM_CACHE_TTL_DAYS,
  ),
);

const orchestrator = new PipelineOrchestrator(
  new CandidateGenerationStage(),
  new DnsPreFilterStage(new NodeDnsProvider()),
  new RdapConfirmationStage(new PublicRdapProvider()),
  new ScoringStage(engine),
  new TrademarkGateStage(trademarkGate),
);

const runService = new PipelineRunService(db, orchestrator, candidateRepo, scoringRepo);

const portfolioManager = new PortfolioManager(
  portfolioRepo,
  config.DROP_SCORE_THRESHOLD,
  config.DROP_RENEWAL_HORIZON_DAYS,
);
portfolioManager.setRescoreService(new PortfolioRescoreService(engine, trademarkGate));

const app = express();
app.use(express.json());
app.use(createRequestLogger(logger));

app.use('/api/candidates', createCandidatesRouter(runService, candidateRepo));
app.use('/api/portfolio', createPortfolioRouter(portfolioManager, outcomeRepo));

app.use(errorHandler);

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'DOMINUS server started');
});
