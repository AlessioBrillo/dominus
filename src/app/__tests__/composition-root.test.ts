// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
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
  SchedulerJobRepository,
} from '../../db/index.js';
import { createKeywordProvider } from '../../providers/keyword/index.js';
import { createCompsProvider } from '../../providers/comps/index.js';
import { NodeDnsProvider, type DnsProvider } from '../../providers/dns/index.js';
import { RateLimiter } from '../../providers/rate-limiter.js';
import { PublicRdapProvider } from '../../providers/rdap/index.js';
import { NodeWhoisProviderWithIanaFallback } from '../../providers/whois/index.js';
import { UsptoCasesProvider, EuipoProvider } from '../../providers/trademark/index.js';
import { ScoringEngine } from '../../scoring/index.js';
import { TrademarkGate } from '../../trademark/index.js';
import {
  PipelineOrchestrator,
  CandidateGenerationStage,
  DnsPreFilterStage,
  RdapConfirmationStage,
  ScoringStage,
  TrademarkGateStage,
} from '../../pipeline/index.js';
import { PortfolioManager, RenewalAlertEngine } from '../../portfolio/index.js';
import { PortfolioRescoreService } from '../../portfolio/portfolio-rescore-service.js';
import { buildNotifiers } from '../../notifiers/index.js';
import { SchedulerService } from '../../scheduler/index.js';
import { WatchlistService } from '../../watchlist/watchlist-service.js';
import { PipelineRunService } from '../index.js';
import { registrarRegistry } from '../../providers/registrar/registrar-registry.js';
import { PurchaseService, AutoApprovalPolicy } from '../../services/purchase-service.js';
import { DomainStatus } from '../../types/domain-status.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function makeDnsProvider(): DnsProvider {
  return {
    name: 'TestDnsProvider',
    checkAvailability: async (_domain: string) => ({
      domain: 'test.com',
      status: DomainStatus.Available,
      checkedAt: new Date().toISOString(),
    }),
    checkBulk: async (_domains: string[]) => [],
    clearCache: (): void => {},
    pruneCache: (): number => 0,
  };
}

describe('Dependency Injection ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â composition-root wiring', () => {
  it('opens SQLite database and runs migrations', () => {
    const provider = openTestDb();

    const tables = provider.rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('schema_migrations');
    expect(tableNames).toContain('candidates');
    expect(tableNames).toContain('portfolio_entries');
    expect(tableNames).toContain('scoring_runs');
    expect(tableNames).toContain('trademark_results');
    expect(tableNames).toContain('outcomes');
    expect(tableNames).toContain('backtest_signals');
    expect(tableNames).toContain('pipeline_runs');
    expect(tableNames).toContain('renewal_alerts');
    expect(tableNames).toContain('watchlist_entries');
    expect(tableNames).toContain('weight_snapshots');
    expect(tableNames).toContain('provider_cache');
    expect(tableNames).toContain('scheduler_jobs');

    provider.close();
  });

  it('constructs all repositories against a live SQLite database', () => {
    const provider = openTestDb();

    const candidateRepo = new CandidateRepository(provider);
    const scoringRepo = new ScoringRepository(provider);
    const portfolioRepo = new PortfolioRepository(provider);
    const trademarkRepo = new TrademarkRepository(provider);
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const outcomeRepo = new OutcomeRepository(provider);
    const alertRepo = new RenewalAlertRepository(provider);
    const pipelineRunsRepo = new PipelineRunsRepository(provider);

    expect(candidateRepo).toBeInstanceOf(CandidateRepository);
    expect(scoringRepo).toBeInstanceOf(ScoringRepository);
    expect(portfolioRepo).toBeInstanceOf(PortfolioRepository);
    expect(trademarkRepo).toBeInstanceOf(TrademarkRepository);
    expect(providerCacheRepo).toBeInstanceOf(ProviderCacheRepository);
    expect(outcomeRepo).toBeInstanceOf(OutcomeRepository);
    expect(alertRepo).toBeInstanceOf(RenewalAlertRepository);
    expect(pipelineRunsRepo).toBeInstanceOf(PipelineRunsRepository);

    provider.close();
  });

  it('constructs keyword and comps providers', () => {
    const provider = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(provider);

    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    expect(keywordProvider).toBeDefined();
    expect(typeof keywordProvider.getMetrics).toBe('function');

    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    expect(compsProvider).toBeDefined();
    expect(typeof compsProvider.getSales).toBe('function');

    provider.close();
  });

  it('constructs scoring engine with default weights', () => {
    const provider = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(provider);

    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    const engine = new ScoringEngine(keywordProvider, compsProvider);

    expect(engine).toBeInstanceOf(ScoringEngine);
    expect(engine.currentWeights).toEqual({
      intrinsic: 0.3,
      commercial: 0.35,
      market: 0.25,
      expiry: 0.1,
    });

    provider.close();
  });

  it('constructs trademark gate with both providers', () => {
    const usptoProvider = new UsptoCasesProvider({
      searchUrl: 'https://tmsearch.uspto.gov/tmsearch',
    });
    const euipoProvider = new EuipoProvider({
      clientId: undefined,
      clientSecret: undefined,
      authUrl: 'https://auth.tmdn.org/oidc/access_token',
      apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
    });
    const gate = new TrademarkGate(usptoProvider, euipoProvider);

    expect(gate).toBeDefined();
    expect(typeof gate.check).toBe('function');
  });

  it('constructs pipeline orchestrator with all stages', () => {
    const provider = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    const engine = new ScoringEngine(keywordProvider, compsProvider);
    const usptoProvider = new UsptoCasesProvider({
      searchUrl: 'https://tmsearch.uspto.gov/tmsearch',
    });
    const euipoProvider = new EuipoProvider({
      clientId: undefined,
      clientSecret: undefined,
      authUrl: 'https://auth.tmdn.org/oidc/access_token',
      apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
    });
    const gate = new TrademarkGate(usptoProvider, euipoProvider);

    const rateLimiter = new RateLimiter({
      maxTokens: 10,
      tokensPerInterval: 10,
      intervalMs: 1000,
    });
    const rdapProvider = new PublicRdapProvider(undefined, undefined, rateLimiter);

    const whoisProvider = new NodeWhoisProviderWithIanaFallback({
      timeoutMs: 5000,
    });

    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage('.com'),
      new DnsPreFilterStage(makeDnsProvider(), 10, []),
      new RdapConfirmationStage(rdapProvider, whoisProvider, 5),
      new ScoringStage(engine),
      new TrademarkGateStage(gate, 3),
    );

    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.run).toBe('function');

    provider.close();
  });

  it('constructs portfolio manager with rescore service', () => {
    const provider = openTestDb();
    const portfolioRepo = new PortfolioRepository(provider);
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const candidateRepo = new CandidateRepository(provider);
    const scoringRepo = new ScoringRepository(provider);
    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    const engine = new ScoringEngine(keywordProvider, compsProvider);
    const usptoProvider = new UsptoCasesProvider({
      searchUrl: 'https://tmsearch.uspto.gov/tmsearch',
    });
    const euipoProvider = new EuipoProvider({
      clientId: undefined,
      clientSecret: undefined,
      authUrl: 'https://auth.tmdn.org/oidc/access_token',
      apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
    });
    const gate = new TrademarkGate(usptoProvider, euipoProvider);

    const manager = new PortfolioManager(portfolioRepo, 25, 60, {
      method: 'threshold',
    });
    const rescoreService = new PortfolioRescoreService(engine, gate, candidateRepo, scoringRepo, 5);
    manager.setRescoreService(rescoreService);

    expect(manager).toBeDefined();
    expect(typeof manager.add).toBe('function');

    provider.close();
  });

  it('constructs pipeline run service with orchestrator', () => {
    const provider = openTestDb();
    const candidateRepo = new CandidateRepository(provider);
    const scoringRepo = new ScoringRepository(provider);
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    const engine = new ScoringEngine(keywordProvider, compsProvider);
    const usptoProvider = new UsptoCasesProvider({
      searchUrl: 'https://tmsearch.uspto.gov/tmsearch',
    });
    const euipoProvider = new EuipoProvider({
      clientId: undefined,
      clientSecret: undefined,
      authUrl: 'https://auth.tmdn.org/oidc/access_token',
      apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
    });
    const gate = new TrademarkGate(usptoProvider, euipoProvider);
    const whoisProvider = new NodeWhoisProviderWithIanaFallback({ timeoutMs: 5000 });
    const dnsProvider = makeDnsProvider();
    const rdapProvider = new PublicRdapProvider(
      undefined,
      undefined,
      new RateLimiter({ maxTokens: 10, tokensPerInterval: 10, intervalMs: 1000 }),
    );

    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage('.com'),
      new DnsPreFilterStage(dnsProvider, 10, []),
      new RdapConfirmationStage(rdapProvider, whoisProvider, 5),
      new ScoringStage(engine),
      new TrademarkGateStage(gate, 3),
    );

    const runService = new PipelineRunService(provider, orchestrator, candidateRepo, scoringRepo);

    expect(runService).toBeDefined();
    expect(typeof runService.run).toBe('function');

    provider.close();
  });

  it('constructs scheduler service without auto-tuner', () => {
    const provider = openTestDb();
    const alertRepo = new RenewalAlertRepository(provider);
    const portfolioRepo = new PortfolioRepository(provider);
    const trademarkRepo = new TrademarkRepository(provider);
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const pipelineRunsRepo = new PipelineRunsRepository(provider);
    const watchlistRepo = new WatchlistRepository(provider);
    const jobRepo = new SchedulerJobRepository(provider);

    const manager = new PortfolioManager(portfolioRepo, 25, 60, { method: 'threshold' });
    const config = {
      SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
      SCHEDULER_RESCORE_CRON: '0 9 * * 1',
      SCHEDULER_PRUNE_CRON: '0 10 1 * *',
      SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
      SCHEDULER_WARMUP_MS: 5000,
      BACKUP_DIR: './data/backup',
      BACKUP_RETENTION_DAYS: 30,
      SCHEDULER_BACKUP_CRON: '0 4 * * *',
      SCHEDULER_PITR_HEALTH_CRON: '*/15 * * * *',
      PITR_WAL_LAG_MAX_BYTES: 64 * 1024 * 1024,
      PITR_BASE_BACKUP_MAX_AGE_HOURS: 26,
      SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: '0 2 * * 0',
      RENEWAL_WARNING_DAYS: 30,
      RENEWAL_CRITICAL_DAYS: 7,
      DEFAULT_RENEWAL_COST_EUR: 10,
      DROP_SCORE_THRESHOLD: 25,
      DROP_RENEWAL_HORIZON_DAYS: 60,
      DROP_METHOD: 'threshold' as const,
      DROP_NPV_DISCOUNT_RATE: 0.05,
      DROP_NPV_HORIZON_YEARS: 5,
      TM_CACHE_TTL_DAYS: 7,
      PROVIDER_CACHE_TTL_DAYS: 7,
      PROVIDER_MEMORY_CACHE_SIZE: 1000,
      PROVIDER_MEMORY_CACHE_TTL_SECONDS: 300,
      DATABASE_PATH: ':memory:',
      DATABASE_BUSY_TIMEOUT: 30000,
      PORT: 3000,
      LOG_LEVEL: 'error' as const,
      LOG_PRETTY: false,
      SCORING_HOLDING_YEARS: 3,
      USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
      EUIPO_AUTH_URL: 'https://auth.tmdn.org/oidc/access_token',
      EUIPO_API_URL: 'https://api.euipo.europa.eu/trademark-search/trademarks',
      KEYWORD_PROVIDER: 'manual' as const,
      COMPS_PROVIDER: 'manual' as const,
      DNS_BULK_CONCURRENCY: 10,
      DNS_LOOKUP_TIMEOUT_MS: 3000,
      DNS_LOOKUP_STRATEGY: 'native',
      DNS_PRIVACY_MODE: false,
      DNS_DOH_ENDPOINT: 'https://cloudflare-dns.com/dns-query',
      DNS_DOH_MAX_CONNECTIONS: 64,
      DNS_CONSENSUS_RATE_LIMIT_TOKENS: 20,
      DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
      DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
      DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      DNS_CONSENSUS_BULK_CONCURRENCY: 20,
      DNS_TERTIARY_ENABLED: false,
      DNS_TERTIARY_STRATEGY: 'native',
      DNS_TERTIARY_NAMESERVERS: undefined,
      DNS_TERTIARY_RATE_LIMIT_TOKENS: 10,
      DNS_TERTIARY_RATE_LIMIT_INTERVAL_MS: 1000,
      DNS_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: 3,
      DNS_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      DNS_TERTIARY_BULK_CONCURRENCY: 10,
      DNS_CONSENSUS_REQUIRED_AVAILABLE: 1,
      DNS_CONSENSUS_PRIORITY_RESERVED_RATIO: 0.3,
      DNS_CONSENSUS_FALLBACK_STRATEGY: 'doh-alternate',
      DNS_CONSENSUS_ON_FAILURE: 'degrade',
      DNS_CACHE_TTL_SECONDS: 300,
      DNS_CACHE_MAX_SIZE: 10000,
      DNS_RATE_LIMIT_TOKENS: 20,
      DNS_RATE_LIMIT_INTERVAL_MS: 1000,
      WHOIS_LOOKUP_TIMEOUT: 10000,
      RDAP_RATE_LIMIT_TOKENS: 10,
      RDAP_RATE_LIMIT_INTERVAL_MS: 1000,
      RDAP_RATE_LIMIT_PER_TENANT_TOKENS: 3,
      RDAP_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      PROVIDER_FAIR_SHARE_ENABLED: false,
      DNS_RATE_LIMIT_PER_TENANT_TOKENS: 5,
      DNS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      USPTO_TSDR_SEARCH_URL: 'https://tsdr.uspto.gov/tsdr/tmsearch/data',
      USPTO_RATE_LIMIT_TOKENS: 5,
      USPTO_RATE_LIMIT_INTERVAL_MS: 1000,
      EUIPO_RATE_LIMIT_TOKENS: 5,
      EUIPO_RATE_LIMIT_INTERVAL_MS: 1000,
      WHOIS_RATE_LIMIT_TOKENS: 1,
      WHOIS_RATE_LIMIT_INTERVAL_MS: 2000,
      WHOIS_RATE_LIMIT_PER_TENANT_TOKENS: 1,
      WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 2000,
      BUY_MAX_ABSOLUTE_CAP: 500,
      HOST: '127.0.0.1',
      NOTIFIER_DESKTOP_ENABLED: false,
      NOTIFIER_WEBHOOK_URL: undefined,
      NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
      NOTIFIER_TELEGRAM_CHAT_ID: undefined,
      SCHEDULER_ENABLED: false,
      WATCHLIST_POLL_INTERVAL_HOURS: 6,
      WATCHLIST_RDAP_DELAY_MS: 200,
      CORS_ORIGIN: '*',
      RATE_LIMIT_WINDOW_MS: 900000,
      RATE_LIMIT_MAX: 100,
      PUBLIC_RATE_LIMIT_WINDOW_MS: 60_000,
      PUBLIC_RATE_LIMIT_MAX: 30,
      PER_DOMAIN_RATE_LIMIT_WINDOW_MS: 60_000,
      PER_DOMAIN_RATE_LIMIT_MAX: 5,
      POST_RATE_LIMIT_WINDOW_MS: 60_000,
      POST_RATE_LIMIT_MAX: 10,
      POST_BODY_MAX_BYTES: 1000,
      RDAP_BATCH_CONCURRENCY: 5,
      RDAP_MAX_CONNECTIONS: 32,
      RDAP_MAX_RESPONSE_BYTES: 1048576,
      RDAP_CONSENSUS_ENABLED: false,
      RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: false,
      RDAP_CONSENSUS_ENDPOINT: '',
      RDAP_BOOTSTRAP_RETRY_BASE_MS: 300000,
      RDAP_BOOTSTRAP_RETRY_MAX_MS: 86400000,
      RDAP_CONSENSUS_DEGRADED_RATIO: 0.5,
      RDAP_CONSENSUS_DEGRADED_MIN: 10,
      RDAP_CONSENSUS_RATE_LIMIT_TOKENS: 5,
      RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS: 1000,
      RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS: 2,
      RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      RDAP_CONSENSUS_BULK_CONCURRENCY: 10,
      RDAP_CONSENSUS_TIMEOUT_MS: 10000,
      RDAP_CONSENSUS_TERTIARY_ENABLED: false,
      RDAP_TERTIARY_ENDPOINT: '',
      RDAP_TERTIARY_RATE_LIMIT_TOKENS: 3,
      RDAP_TERTIARY_RATE_LIMIT_INTERVAL_MS: 1000,
      RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_TOKENS: 1,
      RDAP_TERTIARY_RATE_LIMIT_PER_TENANT_INTERVAL_MS: 1000,
      RDAP_TERTIARY_BULK_CONCURRENCY: 5,
      RDAP_TERTIARY_TIMEOUT_MS: 10000,

      REGISTRAR_PROVIDER: 'manual',
      PURCHASE_AUTO_APPROVAL: 'never' as const,
      AUTO_TUNE_ENABLED: false,
      AUTO_TUNE_WEIGHTS_PATH: './data/weights-override.json',
      AUTO_TUNE_MIN_SAMPLE: 20,
      AUTO_TUNE_MAX_DELTA: 0.05,
      AUTO_TUNE_MAX_DRIFT: 0.2,
      AUTO_TUNE_DRY_RUN: true,
      AUTO_TUNE_CRON: '0 6 1 * *',
      SCORING_IDEAL_LENGTH: 7,
      SCORING_MAX_LENGTH: 20,
      SCORING_MAX_VOLUME: 1000000,
      SCORING_MAX_CPC: 50,
      SCORING_FLOOR_VALUE: 500,
      SCORING_HIGH_VALUE: 10000,
      SCORING_MAX_AGE_YEARS: 20,
      SCORING_MAX_BACKLINKS: 1000,
      SCORING_MAX_WAYBACK: 500,
      SCORING_BUY_MAX_RATIO: 0.5,
      SCORING_LIST_PRICE_MULTIPLIER: 2.5,
      SCORING_BASE_MARKET_VALUE: 500,
      SCORING_CONFIDENCE_BASE: 0.2,
      SCORING_CONFIDENCE_CAP: 0.8,
      TLD_BONUSES_PATH: undefined,
      DEFAULT_KEYWORD_TLD: '.com',
      TRADEMARK_MIN_TOKEN_LENGTH_FUZZY: 4,
      TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING: 3,
      TRADEMARK_MAX_LEVENSHTEIN: 1,
      TRADEMARK_PROVIDER_TIMEOUT_MS: 15000,
      TRADEMARK_BATCH_CONCURRENCY: 3,
      WHOIS_BATCH_CONCURRENCY: 3,
      WHOIS_PER_QUERY_TIMEOUT_MS: 10000,
      RESCORE_BATCH_CONCURRENCY: 5,
      REQUEST_TIMEOUT_MS: 30000,
      FRONTEND_DIST_PATH: './frontend/dist',
      FRONTEND_BASE_PATH: '',
      PUBLIC_CACHE_TTL_MS: 300000,
      ANON_TRADEMARK_BUDGET_ENABLED: false,
      ANON_TRADEMARK_RATE_LIMIT_TOKENS: 2,
      ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS: 1000,
      ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS: 1000,
      NAMEBIO_API_KEY: undefined,
      SCORING_INTRINSIC_QUALITY_INFLUENCE: 0.12,
      FILE_REGISTRAR_CONFIG: undefined,
      KEYWORD_DATA_PATH: './examples/keywords-sample.json',
      COMPS_DATA_PATH: './examples/comps-sample.csv',
      GOOGLE_ADS_CLIENT_ID: undefined,
      GOOGLE_ADS_CLIENT_SECRET: undefined,
      GOOGLE_ADS_REFRESH_TOKEN: undefined,
      GOOGLE_ADS_DEVELOPER_TOKEN: undefined,
      GOOGLE_ADS_CUSTOMER_ID: undefined,
      EUIPO_CLIENT_ID: undefined,
      EUIPO_CLIENT_SECRET: undefined,
      API_KEYS: undefined,
      FILE_API_KEYS: undefined,
      WHOIS_RATE_LIMIT_OVERRIDES: undefined,
      SCORING_WEIGHTS_OVERRIDE: undefined,
      PIPELINE_TIMEOUT_MS: 3600000,
      PIPELINE_CHECKPOINTS_ENABLED: true,
      WORKER_ENABLED: false,
      USAGE_ENFORCEMENT_ENABLED: false,
      AUTO_PROVISION_TENANTS: false,
      WORKER_CONCURRENCY: 2,
      JOB_QUEUE_POLL_INTERVAL_MS: 1000,
      JOB_QUEUE_MAX_DEPTH: 1000,
      JOB_MAX_RUNNING_AGE_MS: 300000,
      JOB_HEARTBEAT_INTERVAL_MS: 15000,
      LISTING_PROVIDER: 'manual' as const,
      LISTING_DEFAULT_MARKETPLACE: 'manual' as const,
      LISTING_DEFAULT_PRICE_MULTIPLIER: 1.0,
      DAN_API_KEY: undefined,
      WAYBACK_ENABLED: true,
      WAYBACK_RATE_LIMIT_TOKENS: 5,
      WAYBACK_RATE_LIMIT_INTERVAL_MS: 12000,
      WAYBACK_TIMEOUT_MS: 10000,
      WAYBACK_BATCH_CONCURRENCY: 3,
      SCORING_BATCH_CONCURRENCY: 5,
      WAYBACK_CDX_PAGE_SIZE: 5000,
      DNS_PARKING_CHECK_ENABLED: false,
      DNS_CIRCUIT_BREAKER_ENABLED: true,
      DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
      DNS_CIRCUIT_BREAKER_WINDOW_MS: 60_000,
      DNS_CIRCUIT_BREAKER_COOLDOWN_MS: 120_000,
      TRUST_PROXY_DEPTH: 1,
      AUTH_PROVIDER: 'env',
      AUTH0_SESSION_TTL_HOURS: 8,
      DNS_PARKING_IPS_PATH: undefined,
      PUBLIC_SCORES_RETENTION_DAYS: 90,
      EVENTS_RETENTION_DAYS: 180,
      REDIS_TLS_ENABLED: false,
      REDIS_KEY_PREFIX: 'dominus:',
      REDIS_MAX_RETRIES: 10,
      REDIS_RETRY_BASE_MS: 200,
      ACQUISITION_BUDGET_EUR: 500,
      ACQUISITION_MIN_CONFIDENCE: 0.3,
      ACQUISITION_MIN_BUY_MAX: 20,
      ACQUISITION_FUNNEL_MAX_ENTRIES: 0,
      DNS_PERSISTENT_CACHE_ENABLED: true,
      DNS_PERSISTENT_CACHE_TTL_HOURS: 24,
      DNS_PERSISTENT_AVAILABLE_STALE_HOURS: 24,
      RDAP_PERSISTENT_AVAILABLE_STALE_HOURS: 24,
      DNS_DNSSEC_VALIDATION_ENABLED: true,
      DNS_CONSENSUS_ENABLED: false,
      DNS_CONSENSUS_STRATEGY: 'dot-only',
      DNS_CONSENSUS_DEGRADED_RATIO: 0.5,
      DNS_CONSENSUS_DEGRADED_MIN: 10,
      DNS_CONSENSUS_RUNTIME_VALIDATION: false,
      DNS_CONSENSUS_RUNTIME_VALIDATION_MODE: 'permissive',
      DNS_CONSENSUS_TEST_DOMAIN: 'example.com',
      DNS_CONSENSUS_VALIDATION_TIMEOUT_MS: 2000,
      DNS_NATIVE_DNSSEC_ENABLED: true,
      DNS_USE_DEDICATED_RESOLVER: true,
      DNS_DOT_POOL_MAX_QUEUED: 4096,
      RDAP_WHOIS_BUDGET_MS: 1000,
      STAGE_TIMEOUT_BASE_MS: 30_000,
      STAGE_TIMEOUT_PER_CANDIDATE_MS: 200,
      STAGE_TIMEOUT_CAP_MS: 3_600_000,
      STAGE_TIMEOUT_GRACE_MS: 5_000,
      RDAP_CONSENSUS_RESCUE_WHOIS_TLDS: [] as string[],
    } as const;

    const notifiers = buildNotifiers(config as Parameters<typeof buildNotifiers>[0]);
    const alertEngine = new RenewalAlertEngine(portfolioRepo, alertRepo, config, notifiers);
    const dnsProvider = new NodeDnsProvider();
    const rdapProvider = new PublicRdapProvider(
      undefined,
      undefined,
      new RateLimiter({ maxTokens: 10, tokensPerInterval: 10, intervalMs: 1000 }),
    );
    const watchlistService = new WatchlistService(
      watchlistRepo,
      dnsProvider,
      rdapProvider,
      notifiers,
      config,
    );

    const scheduler = new SchedulerService({
      config,
      alertEngine,
      portfolioManager: manager,
      trademarkRepo,
      providerCacheRepo,
      runsRepo: pipelineRunsRepo,
      watchlistService,
      jobRepo,
    });

    expect(scheduler).toBeDefined();
    expect(typeof scheduler.start).toBe('function');
    expect(typeof scheduler.stop).toBe('function');

    provider.close();
  });

  it('constructs purchase service with manual registrar', () => {
    const provider = openTestDb();
    const portfolioRepo = new PortfolioRepository(provider);
    const outcomeRepo = new OutcomeRepository(provider);
    const providerCacheRepo = new ProviderCacheRepository(provider);
    const keywordProvider = createKeywordProvider(
      'manual',
      {
        dataFilePath: undefined,
        googleAdsClientId: undefined,
        googleAdsClientSecret: undefined,
        googleAdsRefreshToken: undefined,
        googleAdsDeveloperToken: undefined,
        googleAdsCustomerId: undefined,
      },
      providerCacheRepo,
    );
    const compsProvider = createCompsProvider('manual', {
      csvFilePath: undefined,
      namebioApiKey: undefined,
    });
    const engine = new ScoringEngine(keywordProvider, compsProvider);
    const usptoProvider = new UsptoCasesProvider({
      searchUrl: 'https://tmsearch.uspto.gov/tmsearch',
    });
    const euipoProvider = new EuipoProvider({
      clientId: undefined,
      clientSecret: undefined,
      authUrl: 'https://auth.tmdn.org/oidc/access_token',
      apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
    });
    const gate = new TrademarkGate(usptoProvider, euipoProvider);
    const manager = new PortfolioManager(portfolioRepo, 25, 60, { method: 'threshold' });
    const registrar = registrarRegistry.createActive('manual', {});

    const purchaseService = new PurchaseService({
      registrar,
      portfolioManager: manager,
      outcomeRepo,
      engine,
      gate,
      autoApproval: AutoApprovalPolicy.Never,
      buyMaxAbsoluteCap: 500,
    });

    expect(purchaseService).toBeDefined();
    expect(typeof purchaseService.preflight).toBe('function');

    provider.close();
  });
});
