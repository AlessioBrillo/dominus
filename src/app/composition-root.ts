import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { getLogger } from '../logger.js';
import {
  openDatabase,
  createDatabaseProvider,
  createSqliteProvider,
  createBulkWriteDatabaseProvider,
} from '../db/index.js';
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
  MetricsCollector,
  PipelineProgressService,
} from './index.js';
import { type RateLimiterLike } from '../providers/rate-limiter.js';
import {
  RedisLock,
  CompositeLockProvider,
  DistributedCircuitBreaker,
  getRedisClient,
  type RedisClient,
} from '../providers/redis/index.js';
import type { LockProvider } from '../types/lock.js';
import { EnvApiKeyProvider } from '../providers/auth/env-api-key-provider.js';
import type { AuthProvider } from '../providers/auth/auth-provider.js';
import {
  CircuitBreaker,
  USPTO_CIRCUIT_BREAKER,
  EUIPO_CIRCUIT_BREAKER,
  type ICircuitBreaker,
} from '../providers/circuit-breaker.js';
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
import { AcquisitionFunnelService } from '../services/acquisition-funnel-service.js';
import { FunnelRepository } from '../db/repositories/funnel-repository.js';
import { AnonScoringService } from '../services/anon-scoring-service.js';
import { ListingRepository } from '../db/repositories/listing-repository.js';
import { AutoListingRepository } from '../db/repositories/auto-listing-repository.js';
import { ListingManager } from '../listing/listing-manager.js';
import { createListingProvider, type ListingProviderType } from '../providers/listing/index.js';
import { AutoListingService } from '../services/auto-listing-service.js';
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

const logger = getLogger();

export interface DominusDependencies {
  db: Database.Database | null;
  provider: DatabaseProvider;
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
  funnelService: AcquisitionFunnelService;
  pnlService: PnlService;
  listingManager: ListingManager;
  autoListingService: AutoListingService;

  jobQueueService: ReturnType<typeof createJobQueueService>;
  worker: JobWorker | undefined;
  bulkWriteProvider: DatabaseProvider | undefined;
  authProvider: AuthProvider;
  anonScoringService: AnonScoringService;
}

interface BuiltRepositories {
  provider: DatabaseProvider;
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

function buildRepositories(provider: DatabaseProvider): BuiltRepositories {
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
  usptoRateLimiter: RateLimiterLike,
  euipoRateLimiter: RateLimiterLike,
  redisClient?: RedisClient,
): {
  usptoTmProvider: CachedTrademarkProvider;
  euipoTmProvider: CachedTrademarkProvider;
  trademarkGate: TrademarkGate;
  usptoWafStats: () => { wafBlockCount: number; requestCount: number; wafBlockRate: number };
} {
  const rawUsptoProvider = new UsptoCasesProvider({
    searchUrl: config.USPTO_SEARCH_URL,
    rateLimiter: usptoRateLimiter,
  });

  const usptoCircuitBreaker: ICircuitBreaker = redisClient?.isConnected
    ? new DistributedCircuitBreaker('uspto', USPTO_CIRCUIT_BREAKER, redisClient)
    : new CircuitBreaker(USPTO_CIRCUIT_BREAKER);

  const usptoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(rawUsptoProvider, {}, usptoCircuitBreaker),
    providerCacheRepo,
    'USPTO',
    config.TM_CACHE_TTL_DAYS,
    config.PROVIDER_MEMORY_CACHE_SIZE,
    config.PROVIDER_MEMORY_CACHE_TTL_SECONDS,
  );

  const euipoCircuitBreaker: ICircuitBreaker = redisClient?.isConnected
    ? new DistributedCircuitBreaker('euipo', EUIPO_CIRCUIT_BREAKER, redisClient)
    : new CircuitBreaker(EUIPO_CIRCUIT_BREAKER);

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
      euipoCircuitBreaker,
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

  return {
    usptoTmProvider,
    euipoTmProvider,
    trademarkGate,
    usptoWafStats: () => ({
      wafBlockCount: rawUsptoProvider.wafBlockCount,
      requestCount: rawUsptoProvider.requestCount,
      wafBlockRate: rawUsptoProvider.wafBlockRate,
    }),
  };
}

function buildWorkerIfEnabled(
  config: Config,
  db: Database.Database | null,
  provider: DatabaseProvider,
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
  const backtestEngine = new BacktestEngine(provider, outcomeRepo, backtestSignalsRepo);
  const weightSuggester = new WeightSuggester(
    provider,
    backtestSignalsRepo,
    scoringRepo,
    currentWeights,
  );
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
    provider,
    publicScoresRetentionDays: config.PUBLIC_SCORES_RETENTION_DAYS,
    eventsRetentionDays: config.EVENTS_RETENTION_DAYS,
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
  const worker = new JobWorker(provider, HANDLERS, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.JOB_QUEUE_POLL_INTERVAL_MS,
    maxRunningAgeMs: config.JOB_MAX_RUNNING_AGE_MS,
  });
  worker.start();
  return worker;
}

function buildSchedulerIfEnabled(
  config: Config,
  provider: DatabaseProvider,
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

export async function createDependencies(config: Config): Promise<DominusDependencies> {
  const provider = config.DATABASE_URL
    ? await createDatabaseProvider(config)
    : createSqliteProvider(config);

  // Run schema migrations through the provider (dialect-aware).
  await provider.runMigrations();

  // Open raw SQLite connection for SQLite-specific consumers (CLI maintenance, health check).
  // When using PostgreSQL (DATABASE_URL set), rawDb is undefined — these consumers
  // gracefully handle the absence or are scoped to SQLite-only CLI commands.
  // Raw SQLite connection for consumers that still need it (CLI maintenance, health check, prune).
  // null when using PostgreSQL — those consumers handle null gracefully.
  const db: Database.Database | null = config.DATABASE_URL
    ? null
    : openDatabase(config.DATABASE_PATH, config.DATABASE_BUSY_TIMEOUT);

  warnEuipoIfMissing(config);

  // --- Auth Provider ---
  const authProvider = new EnvApiKeyProvider(config.API_KEYS, config.FILE_API_KEYS);

  // --- Database & Repositories ---
  const repos = buildRepositories(provider);

  // Dedicated bulk-write connection for pipeline persistence (SQLite only).
  // With WAL mode, this lets the main connection serve reads concurrently
  // while a pipeline persists thousands of candidates in a single transaction.
  const bulkWriteProvider = config.DATABASE_URL
    ? undefined
    : createBulkWriteDatabaseProvider(config.DATABASE_PATH, 5000);

  // --- Redis (distributed rate limiting, caching, locking) ---
  // When REDIS_URL is configured, create a shared Redis client and pass it
  // to the provider factory so rate limiters and locks are coordinated
  // across all processes (api, worker, scheduler). Without Redis, all
  // services fall back to in-memory implementations (community edition).
  // See ADR-0033 for the architecture decision.
  let redisClient: RedisClient | undefined;
  if (config.REDIS_URL) {
    redisClient = getRedisClient({
      url: config.REDIS_URL,
      tlsEnabled: config.REDIS_TLS_ENABLED,
      keyPrefix: config.REDIS_KEY_PREFIX,
      maxRetries: config.REDIS_MAX_RETRIES,
      retryBaseMs: config.REDIS_RETRY_BASE_MS,
    });
  }

  // --- Rate Limiters ---
  const {
    rdap: rdapRateLimiter,
    uspto: usptoRateLimiter,
    euipo: euipoRateLimiter,
    dns: dnsRateLimiter,
  } = buildRateLimiters(config, redisClient);

  // --- Providers ---
  const { cached: cachedKeywordProvider } = buildKeywordProvider(config, repos.providerCacheRepo);
  const { cached: cachedCompsProvider } = buildCompsProvider(config, repos.providerCacheRepo);
  const { raw: rawRdapProvider, cached: cachedRdapProvider } = buildRdapProviders(
    config,
    rdapRateLimiter,
    repos.providerCacheRepo,
  );
  const dnsProvider = buildDnsProvider(config, dnsRateLimiter);
  const { withRetry: whoisProvider } = buildWhoisProviders(config);

  // --- Wayback Machine (expiry data enrichment) ---
  const waybackProvider = buildWaybackProvider(config, repos.providerCacheRepo);

  // --- Trademark Gate ---
  const { usptoTmProvider, euipoTmProvider, trademarkGate, usptoWafStats } =
    buildTrademarkProviderStack(
      config,
      repos.providerCacheRepo,
      usptoRateLimiter,
      euipoRateLimiter,
      redisClient,
    );

  // --- Scoring ---
  const { currentWeights, engine } = buildScoringEngine(
    cachedKeywordProvider,
    cachedCompsProvider,
    config,
  );

  // --- Anonymous Scoring Service ---
  const anonScoringService = new AnonScoringService(
    engine,
    trademarkGate,
    config.PUBLIC_CACHE_TTL_MS,
  );

  // --- Health ---
  const healthCheck = new ProviderHealthCheck(
    usptoTmProvider,
    euipoTmProvider,
    rawRdapProvider,
    whoisProvider,
    cachedKeywordProvider,
    {
      dnsProvider,
      compsProvider: cachedCompsProvider,
      ...(waybackProvider !== undefined ? { waybackProvider } : {}),
      usptoWafStats,
    },
  );

  // --- Metrics & Pipeline ---
  const metrics = new MetricsCollector();

  // When Redis is available, use CompositeLockProvider with Redis primary
  // and database-based advisory lock as fallback. This handles the case
  // where Redis goes down mid-operation — the lock falls back to the DB
  // with a clear warning instead of failing all pipeline acquisitions.
  // Without Redis, uses only the database-based advisory lock.
  const lockProvider: LockProvider | undefined = redisClient
    ? new CompositeLockProvider(
        [
          { name: 'RedisLock', provider: new RedisLock(redisClient) },
          { name: 'DatabaseLock', provider },
        ],
        redisClient,
      )
    : undefined;

  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
    new DnsPreFilterStage(dnsProvider, config.DNS_BULK_CONCURRENCY, [CandidateSource.CloseoutCsv]),
    new RdapConfirmationStage(
      cachedRdapProvider,
      whoisProvider,
      config.RDAP_BATCH_CONCURRENCY,
      config.WHOIS_PER_QUERY_TIMEOUT_MS,
    ),
    new ScoringStage(engine, config.SCORING_BATCH_CONCURRENCY, waybackProvider),
    new TrademarkGateStage(trademarkGate, config.TRADEMARK_BATCH_CONCURRENCY),
    config.PIPELINE_TIMEOUT_MS,
    metrics,
    // db (8th param): omitted — delegating to lockProvider when Redis is available
    undefined,
    // lockProvider (9th param): Redis-backed distributed lock when configured
    lockProvider,
  );
  const progressService = new PipelineProgressService();

  // Evict expired entries from in-memory caches before each pipeline run.
  // TTL-based expiry handles freshness; prune avoids the nuclear clearCache().
  orchestrator.setOnRunStart(() => {
    dnsProvider.pruneCache();
    (
      cachedKeywordProvider as unknown as {
        clearCache: () => void;
        pruneCache: () => void;
      }
    ).pruneCache();
    (
      cachedCompsProvider as unknown as {
        clearCache: () => void;
        pruneCache: () => void;
      }
    ).pruneCache();
    usptoTmProvider.pruneCache();
    euipoTmProvider.pruneCache();
  });

  // --- Listing / Sales Pipeline (needed before runService for auto-list hook) ---
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
  const autoListingRepo = new AutoListingRepository(repos.provider);
  const autoListingService = new AutoListingService(listingManager, autoListingRepo);

  const jobQueueService = createJobQueueService(provider);
  const runService = new PipelineRunService(
    repos.provider,
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
    bulkWriteProvider,
  );
  runService.setOnRunComplete(async (result, options) => {
    if (!options?.autoList) return;
    const recommended = result.recommended;
    if (recommended.length === 0) return;

    const domains = recommended.map((c) => ({
      domain: c.domain,
      score: c.scoreResult,
    }));

    const { listed, skipped } = await autoListingService.autoListBatch(
      domains,
      'pipeline_run',
      result.runRowId,
    );

    logger.info(
      { runId: result.runRowId, listed: listed.length, skipped: skipped.length },
      'PipelineRunService: auto-list post-run complete',
    );
  });

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
  const accuracyAnalyzer = new PredictionAccuracyAnalyzer(repos.provider, repos.outcomeRepo);
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
    const backtestEngine = new BacktestEngine(
      repos.provider,
      repos.outcomeRepo,
      backtestSignalsRepo,
    );
    const weightSuggester = new WeightSuggester(
      repos.provider,
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
    autoListingService,
  );

  // --- Acquisition ---
  const acquisitionService = new AcquisitionService(
    repos.acquisitionRepo,
    portfolioManager,
    repos.outcomeRepo,
    provider,
    engine,
    trademarkGate,
    autoListingService,
  );

  // --- Acquisition Funnel ---
  const funnelRepo = new FunnelRepository(provider);
  const funnelService = new AcquisitionFunnelService(
    funnelRepo,
    repos.candidateRepo,
    repos.scoringRepo,
    repos.pipelineRunsRepo,
    {
      budgetEur: config.ACQUISITION_BUDGET_EUR,
      minConfidence: config.ACQUISITION_MIN_CONFIDENCE,
      minBuyMaxEur: config.ACQUISITION_MIN_BUY_MAX,
      maxEntries: config.ACQUISITION_FUNNEL_MAX_ENTRIES,
    },
  );

  // --- P&L ---
  const allOutcomes = await repos.outcomeRepo.findAll();
  const pnlService = new PnlService(repos.portfolioRepo, allOutcomes);

  // --- Backup ---
  const backupService = new BackupService({
    provider,
    backupDir: config.BACKUP_DIR,
    retentionDays: config.BACKUP_RETENTION_DAYS,
  });

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
    bulkWriteProvider,
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
    funnelService,
    pnlService,
    listingManager,
    autoListingService,
    jobQueueService,
    worker,
    authProvider,
    anonScoringService,
  };
}
