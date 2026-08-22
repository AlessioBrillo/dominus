// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { ensureSchemaUpToDate } from '../db/migrator.js';
import { getLogger } from '../logger.js';
import {
  openDatabase,
  createDatabaseProvider,
  createSqliteProvider,
  createBulkWriteDatabaseProvider,
} from '../db/index.js';
import { PostgresAdapter } from '../db/provider/postgres-adapter.js';
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
  SubscriptionRepository,
  MetricsRepository,
  JobQueueRepository,
  PublicScoreRepository,
} from '../db/index.js';
import type { KeywordProvider } from '../providers/keyword/index.js';
import type { CompsProvider } from '../providers/comps/index.js';
import { ProviderHealthCheck } from '../providers/provider-health.js';
import type { WhoisProvider } from '../providers/whois/whois-provider.js';
import { AutoWeightTuner, type ScoringEngine, type ScoringWeights } from '../scoring/index.js';
import { BacktestEngine, WeightSuggester } from '../scoring/backtest/index.js';
import { GateVerdict, TrademarkGate } from '../trademark/index.js';
import {
  PipelineOrchestrator,
  CandidateGenerationStage,
  DnsPreFilterStage,
  RdapConfirmationStage,
  ScoringStage,
  TrademarkGateStage,
  DbCheckpointStore,
} from '../pipeline/index.js';
import type { RdapConsensusConfig } from '../pipeline/stages/rdap-confirmation-stage.js';
import {
  PortfolioManager,
  RenewalAlertEngine,
  PortfolioReportService,
  PnlService,
} from '../portfolio/index.js';
import { PortfolioRescoreService } from '../portfolio/portfolio-rescore-service.js';
import { buildNotifiers } from '../notifiers/index.js';
import type { Notifier } from '../notifiers/notifier.js';
import { SchedulerService, BackupService, PitrHealthService } from '../scheduler/index.js';
import { WatchlistService } from '../watchlist/watchlist-service.js';
import { PredictionAccuracyAnalyzer } from '../analytics/index.js';
import {
  EuipoProvider,
  FailoverTrademarkProvider,
  TsdrTrademarkProvider,
  UsptoCasesProvider,
} from '../providers/trademark/index.js';
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
import type { AuthProvider } from '../providers/auth/auth-provider.js';
import {
  buildAuthProvider,
  isUsageEnforcementActive,
  isMultiTenantAuth,
  buildOidcDeps,
  buildSessionJwt,
} from './auth-factory.js';
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
  buildDnsConsensusConfig,
  buildDnsBreakers,
  probeConsensusProvider,
  probeRdapConsensusEndpoint,
  createRdapConsensusConfig,
  createRdapTertiaryConfig,
  buildWhoisProviders,
  buildRateLimiters,
  buildAnonBudgetGate,
  buildWaybackProvider,
} from './provider-factory.js';
import { DnsBreakerRegistry } from '../providers/dns/dns-breaker.js';
import type { DnsLegSample, DnsLegTelemetry } from '../providers/dns/index.js';
import type { RdapRequestSample, RdapRequestTelemetry } from '../providers/rdap/index.js';
import { RDAP_ORG_UNIVERSAL } from '../providers/rdap/rdap-bootstrap.js';
import { rdapUrlOrigin } from '../providers/rdap/rdap-consensus-validator.js';
import type { DnsProvider } from '../providers/dns/dns-provider.js';
import { buildScoringEngine } from './scoring-factory.js';
import type { PurchaseService as PurchaseServiceType } from '../services/purchase-service.js';
import { AcquisitionRepository } from '../db/repositories/acquisition-repository.js';
import { AcquisitionService } from '../services/acquisition-service.js';
import { BillingService } from '../services/billing-service.js';
import { AdminService } from '../services/admin-service.js';
import { AdminRepository } from '../db/repositories/admin-repository.js';
import { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import { TeamService } from '../services/team-service.js';
import { WebhookEventsRepository } from '../db/repositories/webhook-events-repository.js';
import { UsageRepository } from '../db/repositories/usage-repository.js';
import { UsageMeterService } from '../services/usage-meter-service.js';
import { TenantProvisioningService } from '../services/tenant-provisioning-service.js';
import type { SubscriptionPlan } from '../types/subscription.js';
import { PipelineUsageEnforcer } from '../services/pipeline-usage-enforcer.js';
import { AcquisitionFunnelService } from '../services/acquisition-funnel-service.js';
import { FunnelRepository } from '../db/repositories/funnel-repository.js';
import { AnonScoringService } from '../services/anon-scoring-service.js';
import { ListingRepository } from '../db/repositories/listing-repository.js';
import { ApiKeyRepository } from '../db/repositories/api-key-repository.js';
import { AutoListingRepository } from '../db/repositories/auto-listing-repository.js';
import { ListingManager } from '../listing/listing-manager.js';
import { createListingProvider, type ListingProviderType } from '../providers/listing/index.js';
import { AutoListingService, type AutoListEnqueuer } from '../services/auto-listing-service.js';
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
  HANDLERS,
} from '../jobs/index.js';
import { PortfolioRdapService } from '../portfolio/portfolio-rdap-service.js';

const logger = getLogger();

export interface DominusDependencies {
  db: Database.Database | null;
  provider: DatabaseProvider;
  config: Config;
  /**
   * Actual runtime state of the 2-of-3 DNS consensus gate (true when
   * buildDnsConsensusConfig produced a gate — the gate is silently absent
   * when the secondary resolver set overlaps the primary's). Feeds the
   * provider-status report so it never claims an active gate that is off.
   */
  dnsConsensusActive: boolean;

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
  apiKeyRepo: ApiKeyRepository;
  subscriptionRepo: SubscriptionRepository;
  teamSeatsRepo: TeamSeatsRepository;

  billingService: BillingService;
  usageService: UsageMeterService;
  usageEnforcer: PipelineUsageEnforcer;
  adminService: AdminService;
  adminRepo: AdminRepository;
  teamService: TeamService;

  keywordProvider: KeywordProvider;
  compsProvider: CompsProvider;
  whoisProvider: WhoisProvider;
  dnsProvider: DnsProvider;

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
  publicScoreRepo: PublicScoreRepository;
  /** Undefined in the community edition (env API keys): self-serve signup
   *  exists only where tenants are managed (ADR-0032). */
  provisioningService: TenantProvisioningService | undefined;
  /** Interactive SSO login flow (OIDC PKCE, ADR-0062). Undefined when
   *  AUTH_PROVIDER=auth0 is not fully configured — the /oidc endpoints are
   *  not mounted in that case (fail-closed). */
  oidcDeps: ReturnType<typeof buildOidcDeps>;
  /** Session cookie JWT minter/verifier. Present whenever auth0 mode is
   *  configured; the middleware only consults it when oidcDeps exists. */
  sessionJwt: ReturnType<typeof buildSessionJwt>;
  /** Undefined when REDIS_URL is unset (community edition, in-memory fallbacks). */
  redisClient: RedisClient | undefined;
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
  apiKeyRepo: ApiKeyRepository;
  subscriptionRepo: SubscriptionRepository;
  teamSeatsRepo: TeamSeatsRepository;
  usageRepo: UsageRepository;
  adminRepo: AdminRepository;
  publicScoreRepo: PublicScoreRepository;
  webhookEventsRepo: WebhookEventsRepository;
}

function buildRepositories(provider: DatabaseProvider): BuiltRepositories {
  return {
    provider,
    apiKeyRepo: new ApiKeyRepository(provider),
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
    subscriptionRepo: new SubscriptionRepository(provider),
    teamSeatsRepo: new TeamSeatsRepository(provider),
    usageRepo: new UsageRepository(provider),
    adminRepo: new AdminRepository(provider),
    publicScoreRepo: new PublicScoreRepository(provider),
    webhookEventsRepo: new WebhookEventsRepository(provider),
  };
}

function buildTrademarkProviderStack(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
  usptoRateLimiter: RateLimiterLike,
  euipoRateLimiter: RateLimiterLike,
  redisClient: RedisClient | undefined,
  metrics: MetricsCollector,
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

  const usptoFallbackProvider = new TsdrTrademarkProvider(
    config.USPTO_TSDR_SEARCH_URL,
    usptoRateLimiter,
  );

  const usptoFailoverProvider = new FailoverTrademarkProvider([
    rawUsptoProvider,
    usptoFallbackProvider,
  ]);

  const usptoCircuitBreaker: ICircuitBreaker = redisClient?.isConnected
    ? new DistributedCircuitBreaker('uspto', USPTO_CIRCUIT_BREAKER, redisClient)
    : new CircuitBreaker(USPTO_CIRCUIT_BREAKER);

  const usptoTmProvider = new CachedTrademarkProvider(
    new RetryingTrademarkProvider(usptoFailoverProvider, {}, usptoCircuitBreaker),
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
  const trademarkGate = new TrademarkGate(usptoTmProvider, euipoTmProvider, matchDetectorConfig, {
    providerTimeoutMs: config.TRADEMARK_PROVIDER_TIMEOUT_MS,
    onResult: (stats): void => {
      metrics.recordTrademarkGate({
        verdict:
          stats.verdict === GateVerdict.Blocked
            ? 'blocked'
            : stats.verdict === GateVerdict.Unverified
              ? 'unverified'
              : 'clear',
        partial: stats.partial,
        usptoOk: stats.usptoOk,
        euipoOk: stats.euipoOk,
      });
    },
  });

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
  portfolioHealthcheckService: PortfolioRdapService,
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
  const portfolioHealthcheckHandler = new PortfolioHealthcheckHandler({
    healthcheckService: portfolioHealthcheckService,
  });

  const handlers = [
    pipelineRunHandler,
    portfolioRescoreHandler,
    backtestHandler,
    backupHandler,
    pruneHandler,
    watchlistHandler,
    renewalHandler,
    portfolioHealthcheckHandler,
    ...(weightTuneHandler ? [weightTuneHandler] : []),
  ];
  for (const handler of handlers) {
    HANDLERS.set(handler.jobType, handler);
  }
  const worker = new JobWorker(provider, HANDLERS, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.JOB_QUEUE_POLL_INTERVAL_MS,
    maxRunningAgeMs: config.JOB_MAX_RUNNING_AGE_MS,
    heartbeatIntervalMs: config.JOB_HEARTBEAT_INTERVAL_MS,
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
  portfolioHealthcheckService: PortfolioRdapService,
  lockProvider: LockProvider | undefined,
  metrics: MetricsCollector,
): SchedulerService | undefined {
  if (!config.SCHEDULER_ENABLED) return undefined;

  // PITR is a PostgreSQL concept (ADR-0054): on the SQLite community
  // edition there is no WAL archiving to observe, so no pitr-health job.
  const pitrHealthService =
    provider.dialect === 'postgres'
      ? new PitrHealthService({
          provider,
          walLagMaxBytes: config.PITR_WAL_LAG_MAX_BYTES,
          baseBackupMaxAgeHours: config.PITR_BASE_BACKUP_MAX_AGE_HOURS,
          onCheck: (result): void =>
            metrics.recordPitrCheck({
              walLagBytes: result.walLagBytes,
              baseBackupAgeHours: result.baseBackupAgeHours,
              archivingActive: result.archivingActive,
              checkedAtMs: Date.now(),
            }),
        })
      : undefined;

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
    portfolioHealthcheckService,
    ...(pitrHealthService ? { pitrHealthService } : {}),
    ...(lockProvider ? { lock: lockProvider } : {}),
    ...(autoTuner ? { autoTuner } : {}),
  });
}

export async function createDependencies(config: Config): Promise<DominusDependencies> {
  const provider = config.DATABASE_URL
    ? await createDatabaseProvider(config)
    : createSqliteProvider(config);

  // Schema compatibility preflight + migration run (migration gate): the
  // applied migration set must be a strict prefix of this image's manifest.
  // A database ahead of the image (downgrade deploy, auto-rollback onto a
  // migrated schema) or with unknown migrations fails closed BEFORE any
  // migration runs, so old code can never boot against a schema it does not
  // understand. Restore from a PITR backup instead
  // (docs/releases/migration-policy.md). Same path as the standalone
  // migrate CLI (migrate-before-roll, ADR-0061).
  await ensureSchemaUpToDate(provider);

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
  // Selected via AUTH_PROVIDER (env/db/auth0) — see ADR-0032.
  const authProvider = buildAuthProvider(config, repos.apiKeyRepo);

  // Interactive SSO login flow (OIDC PKCE, ADR-0062). Undefined unless auth0
  // mode is fully configured with client credentials — the /oidc endpoints
  // are not mounted then (fail-closed).
  const oidcDeps = buildOidcDeps(config);
  const sessionJwt = buildSessionJwt(config);

  // Self-serve signup (POST /api/v1/auth/register): only in managed
  // (multi-tenant) identity mode, where tenants and API keys are real
  // rows. The community edition has no tenant concept and no route.
  const keyManager = authProvider.asKeyManager();
  const provisioningService =
    isMultiTenantAuth(config) && keyManager
      ? new TenantProvisioningService(repos.subscriptionRepo, repos.teamSeatsRepo, keyManager)
      : undefined;

  const billingService = new BillingService(
    config,
    repos.subscriptionRepo,
    repos.webhookEventsRepo,
  );
  const usageService = new UsageMeterService(repos.usageRepo, repos.subscriptionRepo, {
    // Auto-provision a free plan on first request for managed (Cloud) setups:
    // DATABASE_URL implies a hosted multi-tenant deployment, AUTH_PROVIDER
    // db/auth0 implies managed identity. Self-hosted community stays strict.
    autoProvisionTenants:
      config.AUTO_PROVISION_TENANTS || !!config.DATABASE_URL || config.AUTH_PROVIDER !== 'env',
    // Operator plan overrides (ADR-0057) win over subscription-derived plans.
    planOverrideProvider: (tenantId: string): Promise<SubscriptionPlan | null> =>
      repos.adminRepo.getAdminFlag(tenantId).then((flag) => flag?.planOverride ?? null),
  });

  // Platform admin read model + tenant lifecycle (ADR-0057): cross-tenant
  // subscriptions, API key counts, metered usage and operator
  // suspend/unsuspend/plan-override for the operator panel (Cloud).
  const adminService = new AdminService(repos.adminRepo, repos.usageRepo);
  // Same plan-override source as UsageMeterService above: an operator grant
  // must raise seat limits exactly like usage limits (ADR-0057).
  const teamService = new TeamService(repos.teamSeatsRepo, repos.subscriptionRepo, {
    planOverrideProvider: (tenantId: string): Promise<SubscriptionPlan | null> =>
      repos.adminRepo.getAdminFlag(tenantId).then((flag) => flag?.planOverride ?? null),
  });

  // Entry-point usage guard shared by the job queue chokepoint, the sync
  // pipeline path, and the portfolio/watchlist add flows (ADR-0038).
  // The admin repo wires the suspended-tenant gate for those chokepoints
  // (ADR-0057); community installs pass none and stay unaffected.
  // Fail-closed in Cloud mode: managed identity implies billing, so
  // enforcement is on even when the operator forgets the env var.
  const usageEnforcer = new PipelineUsageEnforcer(
    usageService,
    isUsageEnforcementActive(config),
    repos.adminRepo,
  );

  // Dedicated bulk-write pool for pipeline persistence.
  // SQLite: separate WAL connection with shorter busy_timeout (5s) for write transactions.
  // PostgreSQL: secondary pg.Pool with fewer connections (3) so large pipeline
  // transactions don't starve read queries on the main pool.
  const bulkWriteProvider = config.DATABASE_URL
    ? await PostgresAdapter.createBulkWrite(config.DATABASE_URL)
    : createBulkWriteDatabaseProvider(config.DATABASE_PATH, 5000);

  // --- Redis (distributed rate limiting, caching, locking) ---
  // When REDIS_URL is configured, create a shared Redis client and pass it
  // to the provider factory so rate limiters and locks are coordinated
  // across all processes (api, worker, scheduler). Without Redis, all
  // services fall back to in-memory implementations (community edition).
  // See ADR-0033 for the architecture decision.
  //
  // In cloud mode (DATABASE_URL set or AUTH_PROVIDER !== 'env'), Redis is
  // required: in-memory fallbacks are per-process and cannot coordinate
  // across api/worker/scheduler containers, leading to split-brain rate
  // limiting and circuit breaker state. Enforced via REDIS_REQUIRED.
  const isCloudMode = !!config.DATABASE_URL || config.AUTH_PROVIDER !== 'env';
  const redisRequired = config.REDIS_REQUIRED !== undefined ? config.REDIS_REQUIRED : isCloudMode;
  let redisClient: RedisClient | undefined;
  if (config.REDIS_URL) {
    redisClient = getRedisClient({
      url: config.REDIS_URL,
      tlsEnabled: config.REDIS_TLS_ENABLED,
      keyPrefix: config.REDIS_KEY_PREFIX,
      maxRetries: config.REDIS_MAX_RETRIES,
      retryBaseMs: config.REDIS_RETRY_BASE_MS,
    });
  } else if (redisRequired) {
    logger.fatal(
      'REDIS_URL is required in cloud mode (DATABASE_URL set or AUTH_PROVIDER !== env). ' +
        'Set REDIS_URL in your environment or configure REDIS_REQUIRED=false for single-process deployments.',
    );
    throw new Error('Redis is required in cloud mode');
  }

  // --- Rate Limiters ---
  const {
    rdap: rdapRateLimiter,
    uspto: usptoRateLimiter,
    euipo: euipoRateLimiter,
    dns: dnsRateLimiter,
    dnsConsensus: dnsConsensusRateLimiter,
    rdapConsensus: rdapConsensusRateLimiter,
  } = buildRateLimiters(config, redisClient);

  // --- Metrics (created before the providers so DNS/RDAP leg telemetry
  //     can feed its histograms; all other consumers read it later) ---
  const metrics = new MetricsCollector();

  // SLO latency telemetry (ADR-0064): per-leg DNS resolution times and
  // per-server RDAP request times land in Prometheus histograms, split by
  // transport/endpoint/verdict/role and by server/outcome respectively.
  const dnsLegTelemetry: DnsLegTelemetry = (leg: DnsLegSample): void => {
    metrics.recordHistogram('dominus_dns_leg_duration_ms', leg.durationMs, {
      transport: leg.transport,
      endpoint: leg.endpoint,
      verdict: leg.verdict,
      role: leg.role,
    });
  };
  const rdapRequestTelemetry: RdapRequestTelemetry = (t: RdapRequestSample): void => {
    metrics.recordHistogram('dominus_rdap_request_duration_ms', t.durationMs, {
      server: t.server,
      outcome: t.outcome,
    });
  };

  // --- Providers ---
  const { cached: cachedKeywordProvider } = buildKeywordProvider(config, repos.providerCacheRepo);
  const { cached: cachedCompsProvider } = buildCompsProvider(config, repos.providerCacheRepo);
  const {
    raw: rawRdapProvider,
    cached: cachedRdapProvider,
    fresh: freshRdapProvider,
    ianaBootstrap,
  } = buildRdapProviders(
    config,
    rdapRateLimiter,
    repos.providerCacheRepo,
    redisClient,
    rdapRequestTelemetry,
  );
  // Shared per-endpoint DNS circuit breaker registry (ADR-0059): primary,
  // secondary, and tertiary consensus providers all consult the same
  // circuits, so a failing endpoint is skipped for every leg that uses it.
  const dnsBreakers = buildDnsBreakers(config, redisClient);
  const dnsProvider = buildDnsProvider(
    config,
    repos.providerCacheRepo,
    dnsRateLimiter,
    dnsBreakers,
    dnsLegTelemetry,
  );
  const { withRetry: whoisProvider } = buildWhoisProviders(config, redisClient);

  // --- Wayback Machine (expiry data enrichment) ---
  const waybackProvider = buildWaybackProvider(config, repos.providerCacheRepo);

  // DNS breaker circuits feed the process-lifetime metrics: every transition
  // (open/half-open/closed) is reflected in the dominus_dns_breaker_* series.
  if (dnsBreakers instanceof DnsBreakerRegistry) {
    dnsBreakers.onChange = (stats): void => metrics.recordDnsBreakers(stats);
  }

  // RDAP bootstrap health feeds the process-lifetime metrics (ADR-0058).
  ianaBootstrap.subscribeStatus((status) => {
    metrics.recordRdapBootstrap({
      ok: status.ok,
      consecutiveFailures: status.consecutiveFailures,
      lastSuccessAtMs: status.lastSuccessAt !== null ? Date.parse(status.lastSuccessAt) : null,
      nextRetryAtMs: status.nextRetryAt,
    });
  });

  // --- Trademark Gate ---
  const { usptoTmProvider, euipoTmProvider, trademarkGate, usptoWafStats } =
    buildTrademarkProviderStack(
      config,
      repos.providerCacheRepo,
      usptoRateLimiter,
      euipoRateLimiter,
      redisClient,
      metrics,
    );

  // --- Scoring ---
  const { currentWeights, engine } = buildScoringEngine(
    cachedKeywordProvider,
    cachedCompsProvider,
    config,
  );

  // --- File watcher for SCORING_WEIGHTS_OVERRIDE hot-reload ---
  // When the operator updates weights via `dominus backtest suggest-weights --apply`,
  // the file is rewritten. We watch for changes and hot-reload the engine without
  // requiring a process restart (critical for worker/scheduler/API running in
  // separate containers in cloud mode).
  if (config.SCORING_WEIGHTS_OVERRIDE !== undefined) {
    const weightsPath = config.SCORING_WEIGHTS_OVERRIDE;
    try {
      const { watchFile } = await import('node:fs');
      const { reloadWeights } = await import('../scoring/weights-loader.js');
      watchFile(weightsPath, { persistent: true, interval: 5000 }, () => {
        try {
          const newWeights = reloadWeights(weightsPath);
          engine.updateWeights(newWeights);
          logger.info({ path: weightsPath }, 'Scoring weights hot-reloaded from file');
        } catch (err) {
          logger.error({ err, path: weightsPath }, 'Failed to hot-reload scoring weights');
        }
      });
      logger.info({ path: weightsPath }, 'Watching scoring weights override file for hot-reload');
    } catch (err) {
      logger.warn(
        { err, path: weightsPath },
        'Could not set up file watcher for weights override (platform limitation)',
      );
    }
  }

  // --- Anonymous Scoring Service ---
  // The public namespace draws trademark-gate budget from its own dedicated
  // allowance (ADR-0056): an anonymous valuation spike can never starve
  // pipeline runs of USPTO/EUIPO capacity. Denials fail open to an
  // 'unverified' verdict, and every grant/denial feeds gate telemetry.
  const anonBudgetGate = buildAnonBudgetGate(config, redisClient);
  const anonScoringService = new AnonScoringService(
    engine,
    trademarkGate,
    config.PUBLIC_CACHE_TTL_MS,
    500,
    repos.publicScoreRepo,
    anonBudgetGate,
    (granted: boolean): void => metrics.recordAnonTrademarkBudget(granted),
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

  // Periodic USPTO WAF stats recording for Prometheus alerting
  // (ADR-0065: USPTO WAF block rate should be observable for SLO alerting).
  void setInterval(() => {
    metrics.recordUsptoWafStats(usptoWafStats());
  }, 30_000).unref();

  // --- Metrics & Pipeline ---
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

  // 2-of-3 DNS consensus: cross-validate Available verdicts against a second,
  // endpoint-disjoint resolver strategy (DNS_CONSENSUS_STRATEGY). Default on —
  // only the Available subset is re-queried, so the extra query volume is
  // bounded while single-resolver availability verdicts are eliminated.
  // The secondary draws from its own rate-limit budget (dnsConsensus,
  // ADR-0044) so it can never be starved by the primary's traffic.
  const dnsConsensusConfig = await buildDnsConsensusConfig(
    config,
    dnsConsensusRateLimiter,
    dnsBreakers,
    dnsLegTelemetry,
    () => metrics.recordDisjointnessResolutionPartial(),
    metrics,
  );
  if (dnsConsensusConfig !== undefined) {
    // Startup probe of the consensus legs: with strict 2-of-3 semantics
    // a dead secondary (or a dead tertiary under requiredAvailable=2)
    // downgrades every Available to Unknown, so surface egress/strategy
    // problems at boot instead of discovering them in runs.
    probeConsensusProvider(
      config,
      dnsConsensusConfig.secondaryProvider,
      dnsConsensusConfig.tertiaryProvider,
    );
  }

  // 2-of-2 RDAP consensus (ADR-0050): a dedicated second RDAP provider on the
  // independent RDAP_CONSENSUS_ENDPOINT re-confirms every Available verdict
  // from the primary leg. Fail-closed — the gate downgrades any candidate the
  // second leg cannot independently confirm. Default on (ADR-0058): the
  // second leg is rdap.org and the primary draws its authoritative per-TLD
  // servers from IANA, so the two legs stay independent. The second leg
  // draws from its own rdapConsensus rate-limit budget (ADR-0044 pattern).
  const rdapConsensusConfig = createRdapConsensusConfig(
    config,
    rdapConsensusRateLimiter,
    redisClient,
    // ADR-0058 origin-overlap guard: authoritative per-TLD origins for the
    // second leg's disjointness check. rdap.org is deliberately excluded —
    // it doubles as the default second leg, mirroring the static
    // disjointness semantics of rdap-consensus-validator.ts.
    async (tld: string): Promise<string[]> => {
      const servers = await ianaBootstrap.getServers(tld);
      return servers
        .map((server) => server.baseUrl)
        .filter((url) => rdapUrlOrigin(url) !== rdapUrlOrigin(RDAP_ORG_UNIVERSAL.baseUrl));
    },
  );
  if (rdapConsensusConfig !== undefined) {
    // Startup probe of the consensus second leg (ADR-0051): with the
    // fail-closed 2-of-2 gate a dead endpoint downgrades every unconfirmable
    // Available verdict, so surface egress problems at boot like the DNS
    // consensus probe does.
    void probeRdapConsensusEndpoint(config, rdapConsensusConfig.secondaryProvider);
  }

  // 2-of-2+1 RDAP consensus: optional tertiary leg (ADR-0050/0064 parallel).
  // When enabled, domains the second leg cannot answer get a third opinion
  // from an independent registry-authoritative endpoint. Mirrors the DNS
  // tertiary leg pattern: dedicated budget, disjointness checks, rescue/veto.
  const rdapTertiaryConfig = await createRdapTertiaryConfig(
    config,
    undefined, // rate limiter will be built inside
    redisClient,
    // ADR-0058 origin-overlap guard: authoritative per-TLD origins for the
    // tertiary leg's disjointness check. Reuses the same resolver as secondary.
    async (tld: string): Promise<string[]> => {
      const servers = await ianaBootstrap.getServers(tld);
      return servers
        .map((server) => server.baseUrl)
        .filter((url) => rdapUrlOrigin(url) !== rdapUrlOrigin(RDAP_ORG_UNIVERSAL.baseUrl));
    },
  );

  // Merge tertiary config into secondary config (same type, tertiary fields
  // extend the base). The stage handles both legs from the unified config.
  let mergedRdapConsensusConfig: RdapConsensusConfig | undefined = rdapConsensusConfig;
  if (rdapTertiaryConfig !== undefined && rdapConsensusConfig !== undefined) {
    mergedRdapConsensusConfig = {
      secondaryProvider: rdapConsensusConfig.secondaryProvider,
      secondaryOrigin: rdapConsensusConfig.secondaryOrigin,
      degradedRatio: rdapConsensusConfig.degradedRatio ?? config.RDAP_CONSENSUS_DEGRADED_RATIO,
      degradedMin: rdapConsensusConfig.degradedMin ?? config.RDAP_CONSENSUS_DEGRADED_MIN,
      consensusConcurrency:
        rdapConsensusConfig.consensusConcurrency ?? config.RDAP_CONSENSUS_BULK_CONCURRENCY,
      rescueWhoisEnabled:
        rdapConsensusConfig.rescueWhoisEnabled ?? config.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED,
      rescueWhoisTlds: rdapConsensusConfig.rescueWhoisTlds ?? new Set<string>(),
      tldOriginsResolver: rdapConsensusConfig.tldOriginsResolver,
      tertiaryProvider: rdapTertiaryConfig.secondaryProvider,
      tertiaryOrigin: rdapTertiaryConfig.secondaryOrigin,
      requiredConfirmations: 1, // Default: secondary alone suffices; tertiary rescues on failure
    } as RdapConsensusConfig;
    // Startup probe for the tertiary leg
    void probeRdapConsensusEndpoint(config, rdapTertiaryConfig.secondaryProvider);
  }

  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
    new DnsPreFilterStage(
      dnsProvider,
      config.DNS_BULK_CONCURRENCY,
      [], // No sources skipped — closeout CSV candidates now go through DNS with forceRecheck
      dnsConsensusConfig,
    ),
    new RdapConfirmationStage(
      cachedRdapProvider,
      whoisProvider,
      config.RDAP_BATCH_CONCURRENCY,
      config.WHOIS_PER_QUERY_TIMEOUT_MS,
      config.RDAP_WHOIS_BUDGET_MS,
      freshRdapProvider,
      mergedRdapConsensusConfig,
    ),
    new ScoringStage(engine, config.SCORING_BATCH_CONCURRENCY, waybackProvider),
    new TrademarkGateStage(trademarkGate, config.TRADEMARK_BATCH_CONCURRENCY),
    config.PIPELINE_TIMEOUT_MS,
    metrics,
    // db (8th param): used as fallback lock when lockProvider is undefined (no Redis).
    // provider implements tryLock/renewLock/unlock via pipeline_locks table.
    provider,
    // lockProvider (9th param): Redis-backed distributed lock when configured
    lockProvider,
    // checkpointStore (10th param): optional durable run checkpoints
    config.PIPELINE_CHECKPOINTS_ENABLED ? new DbCheckpointStore(provider) : undefined,
    // stageBudget (11th param): candidate-scaled per-stage execution budget (ADR-0037)
    {
      baseMs: config.STAGE_TIMEOUT_BASE_MS,
      perCandidateMs: config.STAGE_TIMEOUT_PER_CANDIDATE_MS,
      capMs: config.STAGE_TIMEOUT_CAP_MS,
      graceMs: config.STAGE_TIMEOUT_GRACE_MS,
    },
  );
  const progressService = new PipelineProgressService();

  // Evict expired entries from in-memory caches before each pipeline run.
  // TTL-based expiry handles freshness; prune avoids the nuclear clearCache().
  orchestrator.setOnRunStart(() => {
    dnsProvider.pruneCache();
    // Clear the RDAP intra-run cache (60s TTL) so a fresh run cannot reuse a
    // verdict resolved by a previous run a moment before.
    (rawRdapProvider as { clearCache?: () => void }).clearCache?.();
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

  const jobQueueService = createJobQueueService(provider, { usageEnforcer });

  const autoListEnqueuer: AutoListEnqueuer = {
    async enqueue(domain: string, source: string, scoreJson?: string | null): Promise<string> {
      const domains = [{ domain, scoreJson: scoreJson ?? null }];
      return jobQueueService.enqueueAutoList(domains, 'purchase', source);
    },
  };

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
    usageEnforcer,
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
      undefined,
      options?.signal,
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
    usageEnforcer,
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
    usageEnforcer,
  );

  // --- Portfolio RDAP Healthcheck --- (verifies renewal dates against live RDAP/WHOIS)
  const portfolioHealthcheckService = new PortfolioRdapService(
    cachedRdapProvider,
    whoisProvider,
    repos.portfolioRepo,
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
    autoListEnqueuer,
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
    autoListEnqueuer,
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

  // --- Backup (ADR-0054: onSuccess feeds the BackupStale alert metric) ---
  const backupService = new BackupService({
    provider,
    backupDir: config.BACKUP_DIR,
    retentionDays: config.BACKUP_RETENTION_DAYS,
    onSuccess: (): void => metrics.recordBackupSuccess(Date.now()),
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
    portfolioHealthcheckService,
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
    portfolioHealthcheckService,
    lockProvider,
    metrics,
  );

  return {
    db,
    config,
    dnsConsensusActive: dnsConsensusConfig !== undefined,
    ...repos,
    dnsProvider,
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
    provisioningService,
    oidcDeps,
    sessionJwt,
    anonScoringService,
    redisClient,
    billingService,
    usageService,
    usageEnforcer,
    adminService,
    teamService,
  };
}
