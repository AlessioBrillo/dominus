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
  MetricsRepository,
  JobQueueRepository,
} from '../db/index.js';
import type { KeywordProvider } from '../providers/keyword/index.js';
import type { CompsProvider } from '../providers/comps/index.js';
import { ProviderHealthCheck } from '../providers/provider-health.js';
import type { WhoisProvider } from '../providers/whois/whois-provider.js';
import { AutoWeightTuner, type ScoringEngine, type ScoringWeights } from '../scoring/index.js';
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
  PnlService,
} from '../portfolio/index.js';
import { PortfolioRescoreService } from '../portfolio/portfolio-rescore-service.js';
import { buildNotifiers } from '../notifiers/index.js';
import type { Notifier } from '../notifiers/notifier.js';
import { SchedulerService, BackupService } from '../scheduler/index.js';
import { WatchlistService } from '../watchlist/watchlist-service.js';
import { PredictionAccuracyAnalyzer } from '../analytics/index.js';
import { UsptoCasesProvider, EuipoProvider } from '../providers/trademark/index.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
  warnCloudflareIfMissing,
  MetricsCollector,
  PipelineProgressService,
} from './index.js';
import { type RateLimiter } from '../providers/rate-limiter.js';
import { USPTO_CIRCUIT_BREAKER, EUIPO_CIRCUIT_BREAKER } from './circuit-breaker.js';
import { buildRegistrarProvider, buildPurchaseService } from './registrar-factory.js';
import {
  buildKeywordProvider,
  buildCompsProvider,
  buildRdapProviders,
  buildDnsProvider,
  buildWhoisProviders,
  buildRateLimiters,
  buildWaybackProvider,
} from './provider-factory.js';
import { buildScoringEngine } from './scoring-factory.js';
import type { PurchaseService as PurchaseServiceType } from '../services/purchase-service.js';
import { AcquisitionRepository } from '../db/repositories/acquisition-repository.js';
import { AcquisitionService } from '../services/acquisition-service.js';
import { ListingRepository } from '../db/repositories/listing-repository.js';
import { ListingManager } from '../listing/listing-manager.js';
import { createListingProvider, type ListingProviderType } from '../providers/listing/index.js';
import { createJobQueueService } from './job-queue-service.js';
import {
  JobWorker,
  PipelineRunHandler,
  PortfolioRescoreHandler,
  BacktestBuildHandler,
  BackupHandler,
  PruneHandler,
  WatchlistPollHandler,
  RenewalCheckHandler,
  WeightTuneHandler,
  HANDLERS,
} from '../jobs/index.js';

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
  jobQueueRepo: JobQueueRepository;
  listingRepo: ListingRepository;

  keywordProvider: KeywordProvider;
  compsProvider: CompsProvider;
  whoisProvider: WhoisProvider;

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
  metrics: MetricsCollector;
  metricsRepo: MetricsRepository;
  progressService: PipelineProgressService;
  accuracyAnalyzer: PredictionAccuracyAnalyzer;
  acquisitionService: AcquisitionService;
  pnlService: PnlService;
  listingManager: ListingManager;

  jobQueueService: ReturnType<typeof createJobQueueService>;
  worker: JobWorker | undefined;
}

import { SqliteProvider } from '../db/provider/sqlite-adapter.js';

interface BuiltRepositories {
  provider: SqliteProvider;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  trademarkRepo: TrademarkRepository;
  providerCacheRepo: ProviderCacheRepository;
  outcomeRepo: OutcomeRepository;
  portfolioRepo: PortfolioRepository;
  alertRepo: RenewalAlertRepository;
  pipelineRunsRepo: PipelineRunsRepository;
  metricsRepo: MetricsRepository;
  jobQueueRepo: JobQueueRepository;
  watchlistRepo: WatchlistRepository;
  acquisitionRepo: AcquisitionRepository;
  listingRepo: ListingRepository;
}

function buildRepositories(db: Database.Database): BuiltRepositories {
  const provider = new SqliteProvider(db);
  return {
    provider,
    candidateRepo: new CandidateRepository(provider),
    scoringRepo: new ScoringRepository(provider),
    trademarkRepo: new TrademarkRepository(provider),
    providerCacheRepo: new ProviderCacheRepository(provider),
    outcomeRepo: new OutcomeRepository(provider),
    portfolioRepo: new PortfolioRepository(provider),
    alertRepo: new RenewalAlertRepository(provider),
    pipelineRunsRepo: new PipelineRunsRepository(provider),
    metricsRepo: new MetricsRepository(provider),
    jobQueueRepo: new JobQueueRepository(provider),
    watchlistRepo: new WatchlistRepository(provider),
    acquisitionRepo: new AcquisitionRepository(provider),
    listingRepo: new ListingRepository(provider),
  };
}

function buildTrademarkProviderStack(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
  usptoRateLimiter: RateLimiter,
  euipoRateLimiter: RateLimiter,
): {
  usptoTmProvider: CachedTrademarkProvider;
  euipoTmProvider: CachedTrademarkProvider;
  trademarkGate: TrademarkGate;
} {
  const usptoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(
      new UsptoCasesProvider({ searchUrl: config.USPTO_SEARCH_URL, rateLimiter: usptoRateLimiter }),
      {},
      USPTO_CIRCUIT_BREAKER,
    ),
    providerCacheRepo,
    'USPTO',
    config.TM_CACHE_TTL_DAYS,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );
  const euipoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(
      new EuipoProvider({
        clientId: config.EUIPO_CLIENT_ID,
        clientSecret: config.EUIPO_CLIENT_SECRET,
        authUrl: config.EUIPO_AUTH_URL,
        apiUrl: config.EUIPO_API_URL,
        rateLimiter: euipoRateLimiter,
      }),
      {},
      EUIPO_CIRCUIT_BREAKER,
    ),
    providerCacheRepo,
    'EUIPO',
    config.TM_CACHE_TTL_DAYS,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );

  const matchDetectorConfig = {
    minTokenLengthForFuzzy: config.TRADEMARK_MIN_TOKEN_LENGTH_FUZZY,
    minMarkTokenLengthForSubstring: config.TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING,
    maxLevenshteinDistance: config.TRADEMARK_MAX_LEVENSHTEIN,
  };
  const trademarkGate = new TrademarkGate(usptoTmProvider, euipoTmProvider, matchDetectorConfig);

  return { usptoTmProvider, euipoTmProvider, trademarkGate };
}

function buildWorkerIfEnabled(
  config: Config,
  db: Database.Database,
  provider: SqliteProvider,
  runService: PipelineRunService,
  portfolioManager: PortfolioManager,
  scoringRepo: ScoringRepository,
  currentWeights: ScoringWeights,
  outcomeRepo: OutcomeRepository,
  backupService: BackupService,
  candidateRepo: CandidateRepository,
  pipelineRunsRepo: PipelineRunsRepository,
  providerCacheRepo: ProviderCacheRepository,
  jobQueueRepo: JobQueueRepository,
  watchlistService: WatchlistService,
  alertEngine: RenewalAlertEngine,
  autoTuner: AutoWeightTuner | undefined,
): JobWorker | undefined {
  if (!config.WORKER_ENABLED) return undefined;

  const pipelineRunHandler = new PipelineRunHandler({ runService });
  const portfolioRescoreHandler = new PortfolioRescoreHandler({
    portfolioManager,
    rescoreService: portfolioManager.getRescoreService()!,
  });
  const backtestSignalsRepo = new BacktestSignalsRepository(provider);
  const backtestEngine = new BacktestEngine(db, outcomeRepo, backtestSignalsRepo);
  const weightSuggester = new WeightSuggester(db, backtestSignalsRepo, scoringRepo, currentWeights);
  const backtestHandler = new BacktestBuildHandler({
    backtestEngine,
    weightSuggester,
    currentWeights,
  });
  const backupHandler = new BackupHandler({ backupService });
  const pruneHandler = new PruneHandler({
    candidateRepo,
    scoringRepo,
    pipelineRunsRepo,
    providerCacheRepo,
    jobQueueRepo,
    db,
  });
  const watchlistHandler = new WatchlistPollHandler({ watchlistService });
  const renewalHandler = new RenewalCheckHandler({ alertEngine });
  const weightTuneHandler = autoTuner ? new WeightTuneHandler({ autoTuner }) : undefined;

  const handlers = [
    pipelineRunHandler,
    portfolioRescoreHandler,
    backtestHandler,
    backupHandler,
    pruneHandler,
    watchlistHandler,
    renewalHandler,
    ...(weightTuneHandler ? [weightTuneHandler] : []),
  ];
  for (const handler of handlers) {
    HANDLERS.set(handler.jobType, handler);
  }
  const worker = new JobWorker(db, HANDLERS, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.JOB_QUEUE_POLL_INTERVAL_MS,
    maxRunningAgeMs: config.JOB_MAX_RUNNING_AGE_MS,
  });
  worker.start();
  return worker;
}

function buildSchedulerIfEnabled(
  config: Config,
  provider: SqliteProvider,
  alertEngine: RenewalAlertEngine,
  portfolioManager: PortfolioManager,
  trademarkRepo: TrademarkRepository,
  providerCacheRepo: ProviderCacheRepository,
  pipelineRunsRepo: PipelineRunsRepository,
  watchlistService: WatchlistService,
  backupService: BackupService,
  jobQueueService: ReturnType<typeof createJobQueueService>,
  autoTuner: AutoWeightTuner | undefined,
): SchedulerService | undefined {
  if (!config.SCHEDULER_ENABLED) return undefined;
  return new SchedulerService({
    config,
    alertEngine,
    portfolioManager,
    trademarkRepo,
    providerCacheRepo,
    runsRepo: pipelineRunsRepo,
    watchlistService,
    backupService,
    jobRepo: new SchedulerJobRepository(provider),
    jobQueueService,
    ...(autoTuner ? { autoTuner } : {}),
  });
}

export function createDependencies(config: Config): DominusDependencies {
  const db = openDatabase(config.DATABASE_PATH, config.DATABASE_BUSY_TIMEOUT);
  runMigrations(db);
  warnEuipoIfMissing(config);
  warnCloudflareIfMissing(config);

  // --- Database & Repositories ---
  const repos = buildRepositories(db);

  // --- Rate Limiters ---
  const {
    rdap: rdapRateLimiter,
    uspto: usptoRateLimiter,
    euipo: euipoRateLimiter,
  } = buildRateLimiters(config);

  // --- Providers ---
  const { cached: cachedKeywordProvider } = buildKeywordProvider(config, repos.providerCacheRepo);
  const { cached: cachedCompsProvider } = buildCompsProvider(config, repos.providerCacheRepo);
  const { raw: rawRdapProvider, cached: cachedRdapProvider } = buildRdapProviders(
    config,
    rdapRateLimiter,
    repos.providerCacheRepo,
  );
  const dnsProvider = buildDnsProvider(config);
  const { withRetry: whoisProvider } = buildWhoisProviders(config);

  // --- Wayback Machine (expiry data enrichment) ---
  const waybackProvider = buildWaybackProvider(config, repos.providerCacheRepo);

  // --- Trademark Gate ---
  const { usptoTmProvider, euipoTmProvider, trademarkGate } = buildTrademarkProviderStack(
    config,
    repos.providerCacheRepo,
    usptoRateLimiter,
    euipoRateLimiter,
  );

  // --- Scoring ---
  const { currentWeights, engine } = buildScoringEngine(
    cachedKeywordProvider,
    cachedCompsProvider,
    config,
    waybackProvider,
  );

  // --- Health ---
  const healthCheck = new ProviderHealthCheck(
    usptoTmProvider,
    euipoTmProvider,
    rawRdapProvider,
    whoisProvider,
    cachedKeywordProvider,
  );

  // --- Metrics & Pipeline ---
  const metrics = new MetricsCollector();
  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
    new DnsPreFilterStage(dnsProvider, config.DNS_BULK_CONCURRENCY, [CandidateSource.CloseoutCsv]),
    new RdapConfirmationStage(
      cachedRdapProvider,
      whoisProvider,
      config.RDAP_BATCH_CONCURRENCY,
      config.WHOIS_PER_QUERY_TIMEOUT_MS,
    ),
    new ScoringStage(engine),
    new TrademarkGateStage(trademarkGate, config.TRADEMARK_BATCH_CONCURRENCY),
    config.PIPELINE_TIMEOUT_MS,
    metrics,
  );
  const progressService = new PipelineProgressService();
  const jobQueueService = createJobQueueService(db);
  const runService = new PipelineRunService(
    db,
    orchestrator,
    repos.candidateRepo,
    repos.scoringRepo,
    repos.pipelineRunsRepo,
    undefined,
    undefined,
    repos.metricsRepo,
    progressService,
    jobQueueService,
    config.WORKER_ENABLED,
  );

  // --- Portfolio ---
  const portfolioManager = new PortfolioManager(
    repos.portfolioRepo,
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
      repos.candidateRepo,
      repos.scoringRepo,
      config.RESCORE_BATCH_CONCURRENCY,
    ),
  );

  const notifiers = buildNotifiers(config);
  const alertEngine = new RenewalAlertEngine(
    repos.portfolioRepo,
    repos.alertRepo,
    config,
    notifiers,
  );
  const accuracyAnalyzer = new PredictionAccuracyAnalyzer(db, repos.outcomeRepo);
  const reportService = new PortfolioReportService(
    repos.portfolioRepo,
    repos.outcomeRepo,
    config.DROP_SCORE_THRESHOLD,
    config.RENEWAL_WARNING_DAYS,
  );

  // --- Watchlist ---
  const watchlistService = new WatchlistService(
    repos.watchlistRepo,
    dnsProvider,
    rawRdapProvider,
    notifiers,
    config,
  );

  // --- Auto-Tuner ---
  let autoTuner: AutoWeightTuner | undefined;
  if (config.AUTO_TUNE_ENABLED) {
    const backtestSignalsRepo = new BacktestSignalsRepository(repos.provider);
    const backtestEngine = new BacktestEngine(db, repos.outcomeRepo, backtestSignalsRepo);
    const weightSuggester = new WeightSuggester(
      db,
      backtestSignalsRepo,
      repos.scoringRepo,
      currentWeights,
    );
    const weightSnapshotRepo = new WeightSnapshotRepository(repos.provider);
    autoTuner = new AutoWeightTuner(
      backtestEngine,
      weightSuggester,
      weightSnapshotRepo,
      currentWeights,
      {
        enabled: config.AUTO_TUNE_ENABLED,
        minSampleSize: config.AUTO_TUNE_MIN_SAMPLE,
        maxDeltaPerSignal: config.AUTO_TUNE_MAX_DELTA,
        maxTotalDriftFromDefaults: config.AUTO_TUNE_MAX_DRIFT,
        dryRun: config.AUTO_TUNE_DRY_RUN,
      },
      config.AUTO_TUNE_WEIGHTS_PATH,
      notifiers,
    );
  }

  // --- Purchase ---
  const registrarProvider = buildRegistrarProvider(config);
  const purchaseService = buildPurchaseService(
    registrarProvider,
    portfolioManager,
    repos.outcomeRepo,
    engine,
    trademarkGate,
    config,
  );

  // --- Acquisition ---
  const acquisitionService = new AcquisitionService(
    repos.acquisitionRepo,
    portfolioManager,
    repos.outcomeRepo,
    db,
    engine,
    trademarkGate,
  );

  // --- P&L ---
  const pnlService = new PnlService(repos.portfolioRepo, repos.outcomeRepo.findAll());

  // --- Backup ---
  const backupService = new BackupService({
    db,
    dbPath: config.DATABASE_PATH,
    backupDir: config.BACKUP_DIR,
    retentionDays: config.BACKUP_RETENTION_DAYS,
  });

  // --- Listing / Sales Pipeline ---
  const listingProvider = createListingProvider(config.LISTING_PROVIDER as ListingProviderType, {
    listingRepo: repos.listingRepo,
    danApiKey: config.DAN_API_KEY ?? undefined,
  });
  const listingManager = new ListingManager(
    listingProvider,
    repos.listingRepo,
    engine,
    trademarkGate,
  );

  // --- Worker ---
  const worker = buildWorkerIfEnabled(
    config,
    db,
    repos.provider,
    runService,
    portfolioManager,
    repos.scoringRepo,
    currentWeights,
    repos.outcomeRepo,
    backupService,
    repos.candidateRepo,
    repos.pipelineRunsRepo,
    repos.providerCacheRepo,
    repos.jobQueueRepo,
    watchlistService,
    alertEngine,
    autoTuner,
  );

  // --- Scheduler ---
  const scheduler = buildSchedulerIfEnabled(
    config,
    repos.provider,
    alertEngine,
    portfolioManager,
    repos.trademarkRepo,
    repos.providerCacheRepo,
    repos.pipelineRunsRepo,
    watchlistService,
    backupService,
    jobQueueService,
    autoTuner,
  );

  return {
    db,
    config,
    ...repos,
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
    metrics,
    progressService,
    accuracyAnalyzer,
    acquisitionService,
    pnlService,
    listingManager,
    jobQueueService,
    worker,
  };
}
