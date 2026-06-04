import { loadConfig } from './config.js';
import { openDatabase, runMigrations, PortfolioRepository } from './db/index.js';
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
import { createCli } from './cli/index.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
runMigrations(db);

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
  new PortfolioRepository(db),
  config.DROP_SCORE_THRESHOLD,
  config.DROP_RENEWAL_HORIZON_DAYS,
);

const cli = createCli(orchestrator, portfolioManager, engine);
cli.parse(process.argv);
