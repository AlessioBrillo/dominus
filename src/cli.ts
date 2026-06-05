import { loadConfig } from './config.js';
import { openDatabase, runMigrations, CandidateRepository, ScoringRepository, PortfolioRepository, TrademarkRepository } from './db/index.js';
import { ManualKeywordProvider } from './providers/keyword/index.js';
import { ManualCompsProvider } from './providers/comps/index.js';
import { NodeDnsProvider } from './providers/dns/index.js';
import { PublicRdapProvider } from './providers/rdap/index.js';
import { UsptoCasesProvider, EuipoProvider } from './providers/trademark/index.js';
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
import { PortfolioRescoreService } from './portfolio/portfolio-rescore-service.js';
import { PipelineRunService, CachedTrademarkProvider } from './app/index.js';
import { createCli } from './cli/index.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
runMigrations(db);

const candidateRepo = new CandidateRepository(db);
const scoringRepo = new ScoringRepository(db);
const trademarkRepo = new TrademarkRepository(db);

const keywordProvider = new ManualKeywordProvider(config.KEYWORD_DATA_PATH);
const compsProvider = new ManualCompsProvider(config.COMPS_DATA_PATH);
const engine = new ScoringEngine(keywordProvider, compsProvider);

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
  new PortfolioRepository(db),
  config.DROP_SCORE_THRESHOLD,
  config.DROP_RENEWAL_HORIZON_DAYS,
);
portfolioManager.setRescoreService(new PortfolioRescoreService(engine, trademarkGate));

const cli = createCli(runService, portfolioManager, engine);
cli.parse(process.argv);
