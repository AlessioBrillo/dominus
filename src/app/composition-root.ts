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
import {
  createKeywordProvider,
  type KeywordProvider,
  type KeywordMetrics,
} from '../providers/keyword/index.js';
import { createCompsProvider, type CompsProvider } from '../providers/comps/index.js';
import type { ComparableSale } from '../providers/comps/comps-provider.js';
import { CachedProvider } from '../providers/cached-provider.js';
import { NodeDnsProvider } from '../providers/dns/index.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { PublicRdapProvider } from '../providers/rdap/index.js';
import {
  NodeWhoisProviderWithIanaFallback,
  buildPerTldWhoisRateLimiters,
} from '../providers/whois/index.js';
import { UsptoCasesProvider, EuipoProvider } from '../providers/trademark/index.js';
import { ProviderHealthCheck } from '../providers/provider-health.js';
import {
  ScoringEngine,
  loadWeights,
  loadTldBonuses,
  AutoWeightTuner,
  type ScoringWeights,
  type ScoringConfig,
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
import { SchedulerService } from '../scheduler/index.js';
import { WatchlistService } from '../watchlist/watchlist-service.js';
import {
  PipelineRunService,
  CachedTrademarkProvider,
  RetryingTrademarkProvider,
  warnEuipoIfMissing,
  warnCloudflareIfMissing,
} from './index.js';
import { USPTO_CIRCUIT_BREAKER, EUIPO_CIRCUIT_BREAKER } from './circuit-breaker.js';
import { registrarRegistry } from '../providers/registrar/registrar-registry.js';
import { PurchaseService, AutoApprovalPolicy } from '../services/purchase-service.js';

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
  purchaseService: PurchaseService;
  reportService: PortfolioReportService;
}

export function createDependencies(config: Config): DominusDependencies {
  const db = openDatabase(config.DATABASE_PATH);
  runMigrations(db);
  warnEuipoIfMissing(config);
  warnCloudflareIfMissing(config);

  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);
  const trademarkRepo = new TrademarkRepository(db);
  const providerCacheRepo = new ProviderCacheRepository(db);
  const outcomeRepo = new OutcomeRepository(db);
  const portfolioRepo = new PortfolioRepository(db);
  const alertRepo = new RenewalAlertRepository(db);
  const pipelineRunsRepo = new PipelineRunsRepository(db);

  const keywordProvider = createKeywordProvider(
    config.KEYWORD_PROVIDER,
    {
      dataFilePath: config.KEYWORD_DATA_PATH,
      googleAdsClientId: config.GOOGLE_ADS_CLIENT_ID,
      googleAdsClientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      googleAdsRefreshToken: config.GOOGLE_ADS_REFRESH_TOKEN,
      googleAdsDeveloperToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      googleAdsCustomerId: config.GOOGLE_ADS_CUSTOMER_ID,
    },
    providerCacheRepo,
  );

  // Cache the keyword provider to avoid redundant API calls for the same term
  const keywordCache = new CachedProvider<KeywordMetrics>(
    (term) => keywordProvider.getMetrics(term),
    providerCacheRepo,
    'keyword',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
  );
  const cachedKeywordProvider: KeywordProvider = {
    getMetrics: (term: string) => keywordCache.get(term),
  };
  const compsProvider = createCompsProvider(config.COMPS_PROVIDER, {
    csvFilePath: config.COMPS_DATA_PATH,
    namebioApiKey: config.NAMEBIO_API_KEY,
  });

  // Cache the comps provider to avoid repeated API calls for the same term.
  // The adapter preserves the CompsProvider interface expected by the engine.
  const compsCache = new CachedProvider<ComparableSale[]>(
    (term) => compsProvider.getSales(term),
    providerCacheRepo,
    'comps',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
  );
  const cachedCompsProvider: CompsProvider = {
    getSales: (term: string) => compsCache.get(term),
  };

  const weightsOverridePath =
    config.SCORING_WEIGHTS_OVERRIDE ||
    (config.AUTO_TUNE_ENABLED ? config.AUTO_TUNE_WEIGHTS_PATH : undefined);
  const currentWeights = loadWeights(weightsOverridePath);
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
      confidencePerSignal: config.SCORING_CONFIDENCE_PER_SIGNAL ?? 0.3,
      confidenceCap: config.SCORING_CONFIDENCE_CAP,
      intrinsicQualityInfluence: config.SCORING_INTRINSIC_QUALITY_INFLUENCE,
      holdingYears: config.SCORING_HOLDING_YEARS,
    },
  };

  const engine = new ScoringEngine(
    cachedKeywordProvider,
    cachedCompsProvider,
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

  const trademarkGate = new TrademarkGate(usptoTmProvider, euipoTmProvider, matchDetectorConfig);

  const rdapRateLimiter = new RateLimiter({
    maxTokens: config.RDAP_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.RDAP_RATE_LIMIT_TOKENS,
    intervalMs: config.RDAP_RATE_LIMIT_INTERVAL_MS,
  });
  const whoisDefaultLimiter = new RateLimiter({
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });
  const whoisPerTldLimiters = buildPerTldWhoisRateLimiters(config.WHOIS_RATE_LIMIT_OVERRIDES, {
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });

  const whoisProvider = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    defaultRateLimiter: whoisDefaultLimiter,
    perTldRateLimiters: whoisPerTldLimiters,
  });

  const healthCheck = new ProviderHealthCheck(
    usptoTmProvider,
    euipoTmProvider,
    new PublicRdapProvider(rdapRateLimiter),
    whoisProvider,
    cachedKeywordProvider,
  );

  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(config.DEFAULT_KEYWORD_TLD),
    new DnsPreFilterStage(new NodeDnsProvider(), config.DNS_BULK_CONCURRENCY, [
      CandidateSource.CloseoutCsv,
    ]),
    new RdapConfirmationStage(
      new PublicRdapProvider(rdapRateLimiter),
      whoisProvider,
      config.RDAP_BATCH_CONCURRENCY,
    ),
    new ScoringStage(engine),
    new TrademarkGateStage(trademarkGate, config.TRADEMARK_BATCH_CONCURRENCY),
    config.PIPELINE_TIMEOUT_MS,
  );

  const runService = new PipelineRunService(db, orchestrator, candidateRepo, scoringRepo);

  const portfolioManager = new PortfolioManager(
    portfolioRepo,
    config.DROP_SCORE_THRESHOLD,
    config.DROP_RENEWAL_HORIZON_DAYS,
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

  const watchlistService = new WatchlistService(
    new WatchlistRepository(db),
    new NodeDnsProvider(),
    new PublicRdapProvider(rdapRateLimiter),
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

  // Build registrar config map from prefixed env vars
  const registrarConfig: Record<string, string> = {};
  const registrarEnvPrefix = `REGISTRAR_${config.REGISTRAR_PROVIDER.replace(/-/g, '_').toUpperCase()}_`;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(registrarEnvPrefix) && value !== undefined) {
      const fieldKey = key.slice(registrarEnvPrefix.length).toLowerCase();
      registrarConfig[fieldKey] = value;
    }
  }
  // Also pass legacy Cloudflare vars for backward compat
  if (config.REGISTRAR_PROVIDER === 'cloudflare') {
    registrarConfig['apiToken'] = config.CLOUDFLARE_API_TOKEN ?? registrarConfig['apitoken'] ?? '';
    registrarConfig['accountId'] =
      config.CLOUDFLARE_ACCOUNT_ID ?? registrarConfig['accountid'] ?? '';
  }

  const registrarProvider = registrarRegistry.createActive(
    config.REGISTRAR_PROVIDER,
    registrarConfig,
  );

  const autoApprovalMap: Record<string, AutoApprovalPolicy> = {
    never: AutoApprovalPolicy.Never,
    under_buy_max: AutoApprovalPolicy.UnderBuyMax,
    always: AutoApprovalPolicy.Always,
  };

  const purchaseService = new PurchaseService({
    registrar: registrarProvider,
    portfolioManager,
    outcomeRepo,
    engine,
    gate: trademarkGate,
    autoApproval: autoApprovalMap[config.PURCHASE_AUTO_APPROVAL] ?? AutoApprovalPolicy.Never,
    buyMaxAbsoluteCap: config.BUY_MAX_ABSOLUTE_CAP,
  });

  // ── Scheduler ─────────────────────────────────────────────────────
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
      jobRepo: new SchedulerJobRepository(db),
      ...(autoTuner ? { autoTuner } : {}),
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
    providerCacheRepo,
    keywordProvider,
    compsProvider,
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
