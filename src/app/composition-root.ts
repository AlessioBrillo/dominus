import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { openDatabase, runMigrations } from '../db/index.js';
import {
  CandidateRepository,
  ScoringRepository,
  PortfolioRepository,
  TrademarkRepository,
  ProviderCacheRepository,
  OutcomeRepository,
  RenewalAlertRepository,
  PipelineRunsRepository,
  WatchlistRepository,
  BacktestSignalsRepository,
  WeightSnapshotRepository,
  SchedulerJobRepository,
} from '../db/index.js';
import type { KeywordProvider } from '../providers/keyword/index.js';
import type { CompsProvider } from '../providers/comps/index.js';
import { ProviderHealthCheck } from '../providers/provider-health.js';
import type { NodeWhoisProviderWithIanaFallback } from '../providers/whois/node-whois-provider.js';
import {
  AutoWeightTuner,
  type ScoringEngine,
  type ScoringWeights,
  type AutoTunerConfig,
} from '../scoring/index.js';
import { BacktestEngine, WeightSuggester } from '../scoring/backtest/index.js';
import { TrademarkGate } from '../trademark/index.js';
import { CandidateSource } from '../types/candidate.js';
import {
  PipelineOrchestrator,
  CandidateGenerationStage,
  DnsPreFilterStage,
  RdapConfirmationStage,
  ScoringStage,
  TrademarkGateStage,
} from '../pipeline/index.js';
import {
  PortfolioManager,
  RenewalAlertEngine,
  PortfolioReportService,
} from '../portfolio/index.js';
import { PortfolioRescoreService } from '../portfolio/portfolio-rescore-service.js';
import { buildNotifiers } from '../notifiers/index.js';
import type { Notifier } from '../notifiers/notifier.js';
import { SchedulerService, BackupService } from '../scheduler/index.js';
import { WatchlistService } from '../watchlist/watchlist-service.js';
import { UsptoCasesProvider, EuipoProvider } from '../providers/trademark/index.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
  warnCloudflareIfMissing,
} from './index.js';
import { USPTO_CIRCUIT_BREAKER, EUIPO_CIRCUIT_BREAKER } from './circuit-breaker.js';
import { buildRegistrarProvider, buildPurchaseService } from './registrar-factory.js';
import {
  buildKeywordProvider,
  buildCompsProvider,
  buildRdapProviders,
  buildDnsProvider,
  buildWhoisProviders,
  buildRateLimiters,
} from './provider-factory.js';
import { buildScoringEngine } from './scoring-factory.js';
import type { PurchaseService as PurchaseServiceType } from '../services/purchase-service.js';

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
  providerCacheRepo: ProviderCacheRepository;

  keywordProvider: KeywordProvider;
  compsProvider: CompsProvider;
  whoisProvider: NodeWhoisProviderWithIanaFallback;

  currentWeights: ScoringWeights;
  engine: ScoringEngine;
  trademarkGate: TrademarkGate;

  orchestrator: PipelineOrchestrator;
  runService: PipelineRunService;
  healthCheck: ProviderHealthCheck;

  portfolioManager: PortfolioManager;

  notifiers: Notifier[];
  alertEngine: RenewalAlertEngine;

  watchlistService: WatchlistService;
  scheduler: SchedulerService | undefined;

  autoTuner: AutoWeightTuner | undefined;
  purchaseService: PurchaseServiceType;
  reportService: PortfolioReportService;
}

export function createDependencies(config: Config): DominusDependencies {
  const db = openDatabase(config.DATABASE_PATH);
  runMigrations(db);
  warnEuipoIfMissing(config);
  warnCloudflareIfMissing(config);

  // ── Repositories ────────────────────────────────────────────────────
  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);
  const trademarkRepo = new TrademarkRepository(db);
  const providerCacheRepo = new ProviderCacheRepository(db);
  const outcomeRepo = new OutcomeRepository(db);
  const portfolioRepo = new PortfolioRepository(db);
  const alertRepo = new RenewalAlertRepository(db);
  const pipelineRunsRepo = new PipelineRunsRepository(db);

  // ── Providers ───────────────────────────────────────────────────────
  const { cached: cachedKeywordProvider } = buildKeywordProvider(config, providerCacheRepo);
  const { cached: cachedCompsProvider } = buildCompsProvider(config, providerCacheRepo);
  const { rdap: rdapRateLimiter } = buildRateLimiters(config);
  const { raw: rawRdapProvider, cached: cachedRdapProvider } = buildRdapProviders(
    config,
    rdapRateLimiter,
    providerCacheRepo,
  );
  const dnsProvider = buildDnsProvider();
  const { provider: whoisProvider } = buildWhoisProviders(config);

  // ── Trademark providers ─────────────────────────────────────────────
  const usptoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(
      new UsptoCasesProvider({ searchUrl: config.USPTO_SEARCH_URL }),
      {},
      USPTO_CIRCUIT_BREAKER,
    ),
    providerCacheRepo,
    'USPTO',
    config.TM_CACHE_TTL_DAYS,
  );
  const euipoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(
      new EuipoProvider({
        clientId: config.EUIPO_CLIENT_ID,
        clientSecret: config.EUIPO_CLIENT_SECRET,
        authUrl: config.EUIPO_AUTH_URL,
        apiUrl: config.EUIPO_API_URL,
      }),
      {},
      EUIPO_CIRCUIT_BREAKER,
    ),
    providerCacheRepo,
    'EUIPO',
    config.TM_CACHE_TTL_DAYS,
  );

  const matchDetectorConfig = {
    minTokenLengthForFuzzy: config.TRADEMARK_MIN_TOKEN_LENGTH_FUZZY,
    minMarkTokenLengthForSubstring: config.TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING,
    maxLevenshteinDistance: config.TRADEMARK_MAX_LEVENSHTEIN,
  };
  const trademarkGate = new TrademarkGate(usptoTmProvider, euipoTmProvider, matchDetectorConfig);

  // ── Scoring Engine ──────────────────────────────────────────────────
  const { currentWeights, engine } = buildScoringEngine(
    cachedKeywordProvider,
    cachedCompsProvider,
    config,
  );

  // ── Health Check ────────────────────────────────────────────────────
  const healthCheck = new ProviderHealthCheck(
    usptoTmProvider,
    euipoTmProvider,
    rawRdapProvider,
    whoisProvider,
    cachedKeywordProvider,
  );

  // ── Pipeline ────────────────────────────────────────────────────────
  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
    new DnsPreFilterStage(dnsProvider, config.DNS_BULK_CONCURRENCY, [CandidateSource.CloseoutCsv]),
    new RdapConfirmationStage(cachedRdapProvider, whoisProvider, config.RDAP_BATCH_CONCURRENCY),
    new ScoringStage(engine),
    new TrademarkGateStage(trademarkGate, config.TRADEMARK_BATCH_CONCURRENCY),
    config.PIPELINE_TIMEOUT_MS,
  );
  const runService = new PipelineRunService(db, orchestrator, candidateRepo, scoringRepo);

  // ── Portfolio ───────────────────────────────────────────────────────
  const portfolioManager = new PortfolioManager(
    portfolioRepo,
    config.DROP_SCORE_THRESHOLD,
    config.DROP_RENEWAL_HORIZON_DAYS,
    {
      method: config.DROP_METHOD,
      npvDiscountRate: config.DROP_NPV_DISCOUNT_RATE,
      npvHorizonYears: config.DROP_NPV_HORIZON_YEARS,
    },
  );
  portfolioManager.setRescoreService(
    new PortfolioRescoreService(
      engine,
      trademarkGate,
      candidateRepo,
      scoringRepo,
      config.RESCORE_BATCH_CONCURRENCY,
    ),
  );

  const notifiers = buildNotifiers(config);
  const alertEngine = new RenewalAlertEngine(portfolioRepo, alertRepo, config, notifiers);
  const reportService = new PortfolioReportService(
    portfolioRepo,
    outcomeRepo,
    config.DROP_SCORE_THRESHOLD,
    config.RENEWAL_WARNING_DAYS,
  );

  // ── Watchlist ───────────────────────────────────────────────────────
  const watchlistService = new WatchlistService(
    new WatchlistRepository(db),
    dnsProvider,
    rawRdapProvider,
    notifiers,
    config,
  );

  // ── Auto-weight-tuner (optional) ───────────────────────────────────
  let autoTuner: AutoWeightTuner | undefined;
  if (config.AUTO_TUNE_ENABLED) {
    const backtestSignalsRepo = new BacktestSignalsRepository(db);
    const backtestEngine = new BacktestEngine(db, outcomeRepo, backtestSignalsRepo);
    const weightSuggester = new WeightSuggester(
      db,
      backtestSignalsRepo,
      scoringRepo,
      currentWeights,
    );
    const weightSnapshotRepo = new WeightSnapshotRepository(db);

    const autoTunerConfig: AutoTunerConfig = {
      enabled: config.AUTO_TUNE_ENABLED,
      minSampleSize: config.AUTO_TUNE_MIN_SAMPLE,
      maxDeltaPerSignal: config.AUTO_TUNE_MAX_DELTA,
      maxTotalDriftFromDefaults: config.AUTO_TUNE_MAX_DRIFT,
      dryRun: config.AUTO_TUNE_DRY_RUN,
    };

    autoTuner = new AutoWeightTuner(
      backtestEngine,
      weightSuggester,
      weightSnapshotRepo,
      currentWeights,
      autoTunerConfig,
      config.AUTO_TUNE_WEIGHTS_PATH,
      notifiers,
    );
  }

  // ── Registrar / Purchase Service ────────────────────────────────────
  const registrarProvider = buildRegistrarProvider(config);
  const purchaseService = buildPurchaseService(
    registrarProvider,
    portfolioManager,
    outcomeRepo,
    engine,
    trademarkGate,
    config,
  );

  // ── Backup service ──────────────────────────────────────────────────
  const backupService = new BackupService({
    db,
    dbPath: config.DATABASE_PATH,
    backupDir: config.BACKUP_DIR,
    retentionDays: config.BACKUP_RETENTION_DAYS,
  });

  // ── Scheduler ──────────────────────────────────────────────────────
  let scheduler: SchedulerService | undefined;
  if (config.SCHEDULER_ENABLED) {
    scheduler = new SchedulerService({
      config,
      alertEngine,
      portfolioManager,
      trademarkRepo,
      providerCacheRepo,
      runsRepo: pipelineRunsRepo,
      watchlistService,
      backupService,
      jobRepo: new SchedulerJobRepository(db),
      ...(autoTuner ? { autoTuner } : {}),
    });
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
    providerCacheRepo,
    keywordProvider: cachedKeywordProvider,
    compsProvider: cachedCompsProvider,
    whoisProvider,
    currentWeights,
    engine,
    trademarkGate,
    orchestrator,
    runService,
    healthCheck,
    portfolioManager,
    notifiers,
    alertEngine,
    watchlistService,
    scheduler,
    autoTuner,
    purchaseService,
    reportService,
  };
}
