import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { openDatabase, runMigrations } from '../db/index.js';
import {
  CandidateRepository,
  ScoringRepository,
  PortfolioRepository,
  TrademarkRepository,
  OutcomeRepository,
  RenewalAlertRepository,
  PipelineRunsRepository,
  WatchlistRepository,
} from '../db/index.js';
import { ManualKeywordProvider } from '../providers/keyword/index.js';
import { ManualCompsProvider } from '../providers/comps/index.js';
import { NodeDnsProvider } from '../providers/dns/index.js';
import { PublicRdapProvider } from '../providers/rdap/index.js';
import { NodeWhoisProviderWithIanaFallback } from '../providers/whois/index.js';
import { UsptoCasesProvider, EuipoProvider } from '../providers/trademark/index.js';
import {
  ScoringEngine,
  loadWeights,
  loadTldBonuses,
  type ScoringWeights,
  type ScoringConfig,
} from '../scoring/index.js';
import { TrademarkGate } from '../trademark/index.js';
import {
  PipelineOrchestrator,
  CandidateGenerationStage,
  DnsPreFilterStage,
  RdapConfirmationStage,
  ScoringStage,
  TrademarkGateStage,
} from '../pipeline/index.js';
import { PortfolioManager, RenewalAlertEngine } from '../portfolio/index.js';
import { PortfolioRescoreService } from '../portfolio/portfolio-rescore-service.js';
import { buildNotifiers } from '../notifiers/index.js';
import type { Notifier } from '../notifiers/notifier.js';
import { SchedulerService } from '../scheduler/index.js';
import { WatchlistService } from '../watchlist/watchlist-service.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
  warnCloudflareIfMissing,
} from './index.js';

export interface DominusDependencies {
  db: Database.Database;
  config: Config;

  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  trademarkRepo: TrademarkRepository;
  outcomeRepo: OutcomeRepository;
  portfolioRepo: PortfolioRepository;
  alertRepo: RenewalAlertRepository;
  pipelineRunsRepo: PipelineRunsRepository;

  keywordProvider: ManualKeywordProvider;
  compsProvider: ManualCompsProvider;
  whoisProvider: NodeWhoisProviderWithIanaFallback;

  currentWeights: ScoringWeights;
  engine: ScoringEngine;
  trademarkGate: TrademarkGate;

  orchestrator: PipelineOrchestrator;
  runService: PipelineRunService;

  portfolioManager: PortfolioManager;

  notifiers: Notifier[];
  alertEngine: RenewalAlertEngine;

  watchlistService: WatchlistService;
  scheduler: SchedulerService | undefined;
}

export function createDependencies(config: Config): DominusDependencies {
  const db = openDatabase(config.DATABASE_PATH);
  runMigrations(db);
  warnEuipoIfMissing(config);
  warnCloudflareIfMissing(config);

  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);
  const trademarkRepo = new TrademarkRepository(db);
  const outcomeRepo = new OutcomeRepository(db);
  const portfolioRepo = new PortfolioRepository(db);
  const alertRepo = new RenewalAlertRepository(db);
  const pipelineRunsRepo = new PipelineRunsRepository(db);

  const keywordProvider = new ManualKeywordProvider(config.KEYWORD_DATA_PATH);
  const compsProvider = new ManualCompsProvider(config.COMPS_DATA_PATH);

  const currentWeights = loadWeights(config.SCORING_WEIGHTS_OVERRIDE);
  const tldBonuses = loadTldBonuses(config.TLD_BONUSES_PATH);

  const scoringConfig: ScoringConfig = {
    intrinsic: {
      idealLength: config.SCORING_IDEAL_LENGTH,
      maxLength: config.SCORING_MAX_LENGTH,
    },
    commercial: {
      maxVolume: config.SCORING_MAX_VOLUME,
      maxCpc: config.SCORING_MAX_CPC,
    },
    market: {
      floorValue: config.SCORING_FLOOR_VALUE,
      highValue: config.SCORING_HIGH_VALUE,
    },
    expiry: {
      maxAgeYears: config.SCORING_MAX_AGE_YEARS,
      maxBacklinks: config.SCORING_MAX_BACKLINKS,
      maxWaybackSnapshots: config.SCORING_MAX_WAYBACK,
    },
    constants: {
      buyMaxRatio: config.SCORING_BUY_MAX_RATIO,
      listPriceMultiplier: config.SCORING_LIST_PRICE_MULTIPLIER,
      baseMarketValueEur: config.SCORING_BASE_MARKET_VALUE,
      confidenceBase: config.SCORING_CONFIDENCE_BASE,
      confidencePerSignal: config.SCORING_CONFIDENCE_PER_SIGNAL,
      confidenceCap: config.SCORING_CONFIDENCE_CAP,
      holdingYears: config.SCORING_HOLDING_YEARS,
    },
  };

  const engine = new ScoringEngine(
    keywordProvider,
    compsProvider,
    currentWeights,
    config.BUY_MAX_ABSOLUTE_CAP,
    config.SCORING_RECOMMEND_THRESHOLD,
    config.SCORING_CONFIDENCE_THRESHOLD,
    scoringConfig,
    tldBonuses,
  );

  const matchDetectorConfig = {
    minTokenLengthForFuzzy: config.TRADEMARK_MIN_TOKEN_LENGTH_FUZZY,
    minMarkTokenLengthForSubstring: config.TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING,
    maxLevenshteinDistance: config.TRADEMARK_MAX_LEVENSHTEIN,
  };

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
    matchDetectorConfig,
  );

  const whoisProvider = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
  });

  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
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

  const notifiers = buildNotifiers(config);
  const alertEngine = new RenewalAlertEngine(portfolioRepo, alertRepo, config, notifiers);

  const watchlistService = new WatchlistService(
    new WatchlistRepository(db),
    new NodeDnsProvider(),
    new PublicRdapProvider(),
    notifiers,
    config,
  );

  let scheduler: SchedulerService | undefined;
  if (config.SCHEDULER_ENABLED) {
    scheduler = new SchedulerService({
      config,
      alertEngine,
      portfolioManager,
      trademarkRepo,
      runsRepo: pipelineRunsRepo,
      watchlistService,
    });
    scheduler.start();
  }

  return {
    db,
    config,
    candidateRepo,
    scoringRepo,
    trademarkRepo,
    outcomeRepo,
    portfolioRepo,
    alertRepo,
    pipelineRunsRepo,
    keywordProvider,
    compsProvider,
    whoisProvider,
    currentWeights,
    engine,
    trademarkGate,
    orchestrator,
    runService,
    portfolioManager,
    notifiers,
    alertEngine,
    watchlistService,
    scheduler,
  };
}
