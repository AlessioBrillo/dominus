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
  type CandidateRepository,
  type ScoringRepository,
  type PortfolioRepository,
  type TrademarkRepository,
  type ProviderCacheRepository,
  type OutcomeRepository,
  type RenewalAlertRepository,
  type PipelineRunsRepository,
  BacktestSignalsRepository,
  WeightSnapshotRepository,
  SchedulerJobRepository,
  type MetricsRepository,
  type JobQueueRepository,
} from '../db/index.js';
import { buildRepositories } from './repository-factory.js';
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
  DbCheckpointStore,
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
import {
  UsptoCasesProvider,
  EuipoProvider,
  FailoverTrademarkProvider,
} from '../providers/trademark/index.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
  MetricsCollector,
  PipelineProgressService,
} from './index.js';
import { type RateLimiter } from '../providers/rate-limiter.js';
import { RedisLock, getRedisClient } from '../providers/redis/index.js';
import { EnvApiKeyProvider } from '../providers/auth/env-api-key-provider.js';
import { Auth0Provider } from '../providers/auth/auth0-provider.js';
import { DbApiKeyProvider } from '../providers/auth/db-api-key-provider.js';
import { ApiKeyRepository } from '../db/index.js';
import type { AuthProvider } from '../providers/auth/auth-provider.js';
import { USPTO_CIRCUIT_BREAKER, EUIPO_CIRCUIT_BREAKER } from '../providers/circuit-breaker.js';
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
import { AcquisitionService } from '../services/acquisition-service.js';
import { AnonScoringService } from '../services/anon-scoring-service.js';
import { type ListingRepository, AutoListingRepository } from '../db/index.js';
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
  PortfolioHealthcheckHandler,
  AutoListHandler,
  HANDLERS,
} from '../jobs/index.js';
import { PortfolioRdapService } from '../portfolio/portfolio-rdap-service.js';

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
  pnlService: PnlService;
  listingManager: ListingManager;
  autoListingService: AutoListingService;

  jobQueueService: ReturnType<typeof createJobQueueService>;
  worker: JobWorker | undefined;
  bulkWriteProvider: DatabaseProvider | undefined;
  authProvider: AuthProvider;
  anonScoringService: AnonScoringService;
  apiKeyRepo: ApiKeyRepository | undefined;
}

// BuiltRepositories and buildRepositories moved to repository-factory.ts

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
  // The USPTO provider chain: raw → retry+circuit-breaker → failover → cache.
  // FailoverTrademarkProvider enables operator-configured fallback endpoints
  // (e.g. a self-hosted mirror) via the provider array.
  const usptoTmProvider = new CachedTrademarkProvider(
    new FailoverTrademarkProvider([
      new RetryingTrademarkProvider(
        new UsptoCasesProvider({
          searchUrl: config.USPTO_SEARCH_URL,
          rateLimiter: usptoRateLimiter,
        }),
        {},
        USPTO_CIRCUIT_BREAKER,
      ),
    ]),
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
  healthcheckService: PortfolioRdapService,
  autoListingService: AutoListingService,
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

  const portfolioHealthcheckHandler = new PortfolioHealthcheckHandler({ healthcheckService });

  const autoListHandler = new AutoListHandler({ autoListingService });

  const handlers = [
    pipelineRunHandler,
    portfolioRescoreHandler,
    backtestHandler,
    backupHandler,
    pruneHandler,
    watchlistHandler,
    renewalHandler,
    portfolioHealthcheckHandler,
    autoListHandler,
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

  // Reap orphaned pipeline_runs left by a previously crashed worker so the
  // operator sees a clean run history (ADR-0011 §5.2).
  pipelineRunsRepo
    .reapOrphanedRuns(config.JOB_MAX_RUNNING_AGE_MS)
    .then((count) => {
      if (count > 0) {
        logger.info({ count }, 'Reaped orphaned pipeline runs at worker startup');
      }
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'Failed to reap orphaned pipeline runs at startup');
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
  portfolioHealthcheckService?: PortfolioRdapService,
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
    ...(portfolioHealthcheckService ? { portfolioHealthcheckService } : {}),
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

  // --- Database & Repositories ---
  const repos = buildRepositories(provider);

  // --- Auth Provider ---
  let apiKeyRepo: ApiKeyRepository | undefined;
  const authProvider: AuthProvider = ((): AuthProvider => {
    if (config.AUTH_PROVIDER === 'auth0') {
      return new Auth0Provider({
        domain: config.AUTH0_DOMAIN ?? '',
        audience: config.AUTH0_AUDIENCE ?? '',
        ...(config.AUTH0_JWKS_URI ? { jwksUri: config.AUTH0_JWKS_URI } : {}),
      });
    }
    if (config.AUTH_PROVIDER === 'db') {
      apiKeyRepo = new ApiKeyRepository(provider);
      return new DbApiKeyProvider(apiKeyRepo);
    }
    return new EnvApiKeyProvider(config.API_KEYS, config.FILE_API_KEYS);
  })();

  // Dedicated bulk-write connection for pipeline persistence (SQLite only).
  // With WAL mode, this lets the main connection serve reads concurrently
  // while a pipeline persists thousands of candidates in a single transaction.
  const bulkWriteProvider = config.DATABASE_URL
    ? undefined
    : createBulkWriteDatabaseProvider(config.DATABASE_PATH, 5000);

  // --- Rate Limiters ---
  const {
    rdap: rdapRateLimiter,
    uspto: usptoRateLimiter,
    euipo: euipoRateLimiter,
    dns: dnsRateLimiter,
  } = buildRateLimiters(config);

  // --- Providers ---
  const { cached: cachedKeywordProvider } = buildKeywordProvider(config, repos.providerCacheRepo);
  const { cached: cachedCompsProvider } = buildCompsProvider(config, repos.providerCacheRepo);
  const { raw: rawRdapProvider, cached: cachedRdapProvider } = buildRdapProviders(
    config,
    rdapRateLimiter,
    repos.providerCacheRepo,
  );
  const dnsProvider = buildDnsProvider(config, dnsRateLimiter, repos.providerCacheRepo);
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
  );

  // --- Portfolio RDAP/WHOIS Healthcheck Service ---
  // Verifies portfolio domains against live RDAP/WHOIS for renewal date accuracy.
  // Uses the raw (uncached) RDAP provider because healthchecks must always fetch
  // fresh data — stale cached responses defeat the purpose of the check.
  const healthcheckService = new PortfolioRdapService(
    rawRdapProvider,
    whoisProvider,
    repos.portfolioRepo,
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
    },
  );

  // --- Redis (distributed locking, caching) ---
  let redisLock: RedisLock | undefined;
  if (config.REDIS_URL) {
    const redisClient = getRedisClient({
      url: config.REDIS_URL,
      tlsEnabled: config.REDIS_TLS_ENABLED,
      keyPrefix: config.REDIS_KEY_PREFIX,
      maxRetries: config.REDIS_MAX_RETRIES,
      retryBaseMs: config.REDIS_RETRY_BASE_MS,
    });
    redisLock = new RedisLock(redisClient);
  }

  // --- Metrics & Pipeline ---
  const metrics = new MetricsCollector();
  const checkpointStore = new DbCheckpointStore(provider);
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
    provider,
    redisLock,
    checkpointStore,
  );
  const progressService = new PipelineProgressService();

  // Clear in-memory provider caches before each pipeline run to prevent stale
  // DNS, trademark, keyword, or comps data from being reused across runs.
  orchestrator.setOnRunStart(() => {
    dnsProvider.clearCache();
    cachedKeywordProvider.clearCache?.();
    cachedCompsProvider.clearCache?.();
    usptoTmProvider.clearCache();
    euipoTmProvider.clearCache();
    anonScoringService.clearCache();
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

  const jobQueueService = createJobQueueService(provider, {
    maxQueueDepth: config.JOB_QUEUE_MAX_DEPTH,
  });
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
      scoreJson: c.scoreResult ? JSON.stringify(c.scoreResult) : null,
    }));

    // Enqueue asynchronously — the job worker processes the listing
    // outside the pipeline completion path so the HTTP response or
    // worker slot is not blocked by marketplace API latency.
    try {
      const jobId = await jobQueueService.enqueueAutoList(domains, result.runRowId, 'pipeline_run');
      logger.info(
        { runId: result.runRowId, jobId, domainCount: domains.length },
        'PipelineRunService: auto-list job enqueued',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { runId: result.runRowId, err: message },
        'PipelineRunService: failed to enqueue auto-list job',
      );
    }
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
    config.DEFAULT_RENEWAL_COST_EUR,
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
    healthcheckService,
    autoListingService,
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
    healthcheckService,
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
    pnlService,
    listingManager,
    autoListingService,
    jobQueueService,
    worker,
    authProvider,
    anonScoringService,
    apiKeyRepo,
  };
}
