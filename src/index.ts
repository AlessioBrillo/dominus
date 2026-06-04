import express from 'express';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { openDatabase, runMigrations } from './db/index.js';
import {
  CandidateRepository,
  PortfolioRepository,
} from './db/index.js';
import { NodeDnsProvider } from './providers/dns/index.js';
import { PublicRdapProvider } from './providers/rdap/index.js';
import { UsptoCasesProvider, EuipoProvider } from './providers/trademark/index.js';
import { ManualKeywordProvider } from './providers/keyword/index.js';
import { ManualCompsProvider } from './providers/comps/index.js';
import { ScoringEngine } from './scoring/index.js';
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
const portfolioRepo = new PortfolioRepository(db);

const keywordProvider = new ManualKeywordProvider();
const compsProvider = new ManualCompsProvider();
const engine = new ScoringEngine(keywordProvider, compsProvider);

const trademarkGate = new TrademarkGate(new UsptoCasesProvider(), new EuipoProvider());

const orchestrator = new PipelineOrchestrator(
  new CandidateGenerationStage(),
  new DnsPreFilterStage(new NodeDnsProvider()),
  new RdapConfirmationStage(new PublicRdapProvider()),
  new ScoringStage(engine),
  new TrademarkGateStage(trademarkGate),
);

const portfolioManager = new PortfolioManager(
  portfolioRepo,
  config.DROP_SCORE_THRESHOLD,
  config.DROP_RENEWAL_HORIZON_DAYS,
);

const app = express();
app.use(express.json());
app.use(createRequestLogger(logger));

app.use('/api/candidates', createCandidatesRouter(orchestrator, candidateRepo));
app.use('/api/portfolio', createPortfolioRouter(portfolioManager));

app.use(errorHandler);

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'DOMINUS server started');
});
