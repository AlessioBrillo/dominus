import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
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
import { NodeDnsProvider } from '../../providers/dns/index.js';
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
  WhoisStage,
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
import type { DnsProvider } from '../../providers/dns/dns-provider.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeDnsProvider(): DnsProvider {
  return {
    checkAvailability: async (_domain: string) => ({
      domain: 'test.com',
      status: DomainStatus.Available,
      checkedAt: new Date().toISOString(),
    }),
    checkBulk: async (_domains: string[]) => [],
  };
}

describe('Dependency Injection â€” composition-root wiring', () => {
  it('opens SQLite database and runs migrations', () => {
    const db = openTestDb();

    const tables = db
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

    db.close();
  });

  it('constructs all repositories against a live SQLite database', () => {
    const db = openTestDb();

    const candidateRepo = new CandidateRepository(db);
    const scoringRepo = new ScoringRepository(db);
    const portfolioRepo = new PortfolioRepository(db);
    const trademarkRepo = new TrademarkRepository(db);
    const providerCacheRepo = new ProviderCacheRepository(db);
    const outcomeRepo = new OutcomeRepository(db);
    const alertRepo = new RenewalAlertRepository(db);
    const pipelineRunsRepo = new PipelineRunsRepository(db);

    expect(candidateRepo).toBeInstanceOf(CandidateRepository);
    expect(scoringRepo).toBeInstanceOf(ScoringRepository);
    expect(portfolioRepo).toBeInstanceOf(PortfolioRepository);
    expect(trademarkRepo).toBeInstanceOf(TrademarkRepository);
    expect(providerCacheRepo).toBeInstanceOf(ProviderCacheRepository);
    expect(outcomeRepo).toBeInstanceOf(OutcomeRepository);
    expect(alertRepo).toBeInstanceOf(RenewalAlertRepository);
    expect(pipelineRunsRepo).toBeInstanceOf(PipelineRunsRepository);

    db.close();
  });

  it('constructs keyword and comps providers', () => {
    const db = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(db);

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

    db.close();
  });

  it('constructs scoring engine with default weights', () => {
    const db = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(db);

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

    db.close();
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
    const db = openTestDb();
    const providerCacheRepo = new ProviderCacheRepository(db);
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
      new WhoisStage(whoisProvider, 3),
      new RdapConfirmationStage(rdapProvider, whoisProvider, 5),
      new ScoringStage(engine),
      new TrademarkGateStage(gate, 3),
    );

    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.run).toBe('function');

    db.close();
  });

  it('constructs portfolio manager with rescore service', () => {
    const db = openTestDb();
    const portfolioRepo = new PortfolioRepository(db);
    const providerCacheRepo = new ProviderCacheRepository(db);
    const candidateRepo = new CandidateRepository(db);
    const scoringRepo = new ScoringRepository(db);
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

    db.close();
  });

  it('constructs pipeline run service with orchestrator', () => {
    const db = openTestDb();
    const candidateRepo = new CandidateRepository(db);
    const scoringRepo = new ScoringRepository(db);
    const providerCacheRepo = new ProviderCacheRepository(db);
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
      new WhoisStage(whoisProvider, 3),
      new RdapConfirmationStage(rdapProvider, whoisProvider, 5),
      new ScoringStage(engine),
      new TrademarkGateStage(gate, 3),
    );

    const runService = new PipelineRunService(db, orchestrator, candidateRepo, scoringRepo);

    expect(runService).toBeDefined();
    expect(typeof runService.run).toBe('function');

    db.close();
  });

  it('constructs scheduler service without auto-tuner', () => {
    const db = openTestDb();
    const alertRepo = new RenewalAlertRepository(db);
    const portfolioRepo = new PortfolioRepository(db);
    const trademarkRepo = new TrademarkRepository(db);
    const providerCacheRepo = new ProviderCacheRepository(db);
    const pipelineRunsRepo = new PipelineRunsRepository(db);
    const watchlistRepo = new WatchlistRepository(db);
    const jobRepo = new SchedulerJobRepository(db);

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
      RENEWAL_WARNING_DAYS: 30,
      RENEWAL_CRITICAL_DAYS: 7,
      DROP_SCORE_THRESHOLD: 25,
      DROP_RENEWAL_HORIZON_DAYS: 60,
      DROP_METHOD: 'threshold' as const,
      DROP_NPV_DISCOUNT_RATE: 0.05,
      DROP_NPV_HORIZON_YEARS: 5,
      TM_CACHE_TTL_DAYS: 7,
      PROVIDER_CACHE_TTL_DAYS: 7,
      DATABASE_PATH: ':memory:',
      PORT: 3000,
      LOG_LEVEL: 'error' as const,
      LOG_PRETTY: false,
      SCORING_CONFIDENCE_THRESHOLD: 0.3,
      SCORING_HOLDING_YEARS: 3,
      USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
      EUIPO_AUTH_URL: 'https://auth.tmdn.org/oidc/access_token',
      EUIPO_API_URL: 'https://api.euipo.europa.eu/trademark-search/trademarks',
      KEYWORD_PROVIDER: 'manual' as const,
      COMPS_PROVIDER: 'manual' as const,
      DNS_BULK_CONCURRENCY: 10,
      DNS_LOOKUP_TIMEOUT_MS: 3000,
      WHOIS_LOOKUP_TIMEOUT: 10000,
      RDAP_RATE_LIMIT_TOKENS: 10,
      RDAP_RATE_LIMIT_INTERVAL_MS: 1000,
      USPTO_RATE_LIMIT_TOKENS: 5,
      USPTO_RATE_LIMIT_INTERVAL_MS: 1000,
      EUIPO_RATE_LIMIT_TOKENS: 5,
      EUIPO_RATE_LIMIT_INTERVAL_MS: 1000,
      WHOIS_RATE_LIMIT_TOKENS: 1,
      WHOIS_RATE_LIMIT_INTERVAL_MS: 2000,
      BUY_MAX_ABSOLUTE_CAP: 500,
      SCORING_RECOMMEND_THRESHOLD: 0.4,
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
      RDAP_BATCH_CONCURRENCY: 5,
      REGISTRAR_PROVIDER: 'manual',
      PURCHASE_AUTO_APPROVAL: 'never' as const,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: undefined,
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
      SCORING_CONFIDENCE_PER_SIGNAL: 0.3,
      SCORING_CONFIDENCE_CAP: 0.8,
      TLD_BONUSES_PATH: undefined,
      DEFAULT_KEYWORD_TLD: '.com',
      TRADEMARK_MIN_TOKEN_LENGTH_FUZZY: 4,
      TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING: 3,
      TRADEMARK_MAX_LEVENSHTEIN: 1,
      TRADEMARK_BATCH_CONCURRENCY: 3,
      WHOIS_BATCH_CONCURRENCY: 3,
      RESCORE_BATCH_CONCURRENCY: 5,
      REQUEST_TIMEOUT_MS: 30000,
      FRONTEND_DIST_PATH: './frontend/dist',
      FRONTEND_BASE_PATH: '',
      NAMEBIO_API_KEY: undefined,
      SCORING_INTRINSIC_QUALITY_INFLUENCE: 0.12,
      FILE_REGISTRAR_CONFIG: undefined,
      KEYWORD_DATA_PATH: undefined,
      COMPS_DATA_PATH: undefined,
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

    db.close();
  });

  it('constructs purchase service with manual registrar', () => {
    const db = openTestDb();
    const portfolioRepo = new PortfolioRepository(db);
    const outcomeRepo = new OutcomeRepository(db);
    const providerCacheRepo = new ProviderCacheRepository(db);
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

    db.close();
  });
});
