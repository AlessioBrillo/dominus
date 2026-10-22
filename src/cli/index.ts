// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import type { PipelineRunService } from '../app/pipeline-run-service.js';
import type { JobQueueService } from '../app/job-queue-service.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { Config } from '../config.js';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
import type { RenewalAlertRepository } from '../db/repositories/renewal-alert-repository.js';
import { BackupService } from '../scheduler/backup-service.js';
import { SqliteProvider } from '../db/provider/sqlite-adapter.js';
import { UsageRepository } from '../db/repositories/usage-repository.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { ScoringWeights } from '../scoring/weights.js';
import type { PurchaseService } from '../services/purchase-service.js';
import type { WatchlistService } from '../watchlist/watchlist-service.js';
import type { PortfolioReportService } from '../portfolio/portfolio-report-service.js';
import type { PredictionAccuracyAnalyzer } from '../analytics/index.js';
import type { AcquisitionService } from '../services/acquisition-service.js';
import type { AcquisitionFunnelService } from '../services/acquisition-funnel-service.js';
import type { ListingManager } from '../listing/listing-manager.js';
import type { PostAcquisitionService } from '../services/post-acquisition-service.js';
import type { KeyManager } from '../providers/auth/auth-provider.js';
import type { ApiKeyRepository } from '../db/repositories/api-key-repository.js';
import type { DatabaseProvider } from '../db/provider/interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadCliVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
import { registerListingCommand } from './commands/listing-command.js';
import { registerAutomateCommand } from './commands/automate-command.js';
import { registerRunCommand } from './commands/run-command.js';
import { registerBidCommand } from './commands/bid-command.js';
import { registerPortfolioCommand } from './commands/portfolio-command.js';
import { registerScoreCommand } from './commands/score-command.js';
import { registerOutcomeCommand } from './commands/outcome-command.js';
import { registerBacktestCommand } from './commands/backtest-command.js';
import { registerRunsCommand } from './commands/runs-command.js';
import { registerMaintenanceCommand } from './commands/maintenance-command.js';
import { registerProvidersCommand } from './commands/providers-command.js';
import { registerCandidatesCommand } from './commands/candidates-command.js';
import { registerHealthCommand } from './commands/health-command.js';
import { registerSchedulerCommand } from './commands/scheduler-command.js';
import { registerWatchlistCommand } from './commands/watchlist-command.js';
import { registerBuyCommand } from './commands/buy-command.js';
import { registerFunnelCommand } from './commands/funnel-command.js';
import { registerRegistrarsCommand } from './commands/registrars-command.js';
import { registerReportCommand } from './commands/report-command.js';
import { registerAnalyticsCommand } from './commands/analytics-command.js';
import { registerKeysCommand } from './commands/keys-command.js';
import { registerTenantCommand } from './commands/tenant-command.js';

export interface CreateCliOptions {
  db: Database.Database | null;
  runService: PipelineRunService;
  manager: PortfolioManager;
  engine: ScoringEngine;
  outcomeRepo: OutcomeRepository;
  config: Config;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  trademarkRepo: TrademarkRepository;
  providerCacheRepo?: ProviderCacheRepository;
  runsRepo: PipelineRunsRepository;
  gate?: TrademarkGate;
  alertEngine?: RenewalAlertEngine;
  alertRepo?: RenewalAlertRepository;
  scheduler: SchedulerService | undefined;
  jobQueueService?: JobQueueService | undefined;
  watchlistService?: WatchlistService | undefined;
  currentWeights?: ScoringWeights;
  purchaseService?: PurchaseService;
  reportService?: PortfolioReportService;
  accuracyAnalyzer?: PredictionAccuracyAnalyzer;
  acquisitionService?: AcquisitionService;
  funnelService?: AcquisitionFunnelService;
  listingManager?: ListingManager;
  postAcquisitionService?: PostAcquisitionService;
  keyManager?: KeyManager | undefined;
  apiKeyRepo?: ApiKeyRepository | undefined;
  provider?: DatabaseProvider | undefined;
}

/**
 * The CLI of the decision profile.
 *
 * The decision profile answers a question about a domain without writing
 * anything down, so it does not need the portfolio, the run history, the
 * database or the worker - and it must not open the database, because a
 * command that answers a question does not create a database file next to
 * the user.
 */
export interface DecisionCliOptions {
  config: Config;
  engine: ScoringEngine;
  gate?: TrademarkGate;
}

export function createDecisionCli(options: DecisionCliOptions): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version(loadCliVersion());

  registerScoreCommand(program, options.engine, options.gate);

  return program;
}

/**
 * A service that is not there.
 *
 * The catalog program exists to PRINT the command line: the same commands,
 * the same options, the same descriptions, without the application behind
 * them. A property read returns another placeholder — the registration
 * reads a few of them — and a CALL fails loudly, because a command that
 * is actually run must not find an application that was never built.
 */
function notBuilt<T>(): T {
  const placeholder = new Proxy(
    {},
    {
      get(_target, _property): unknown {
        return placeholder;
      },
      apply(): never {
        throw new Error(
          'the catalog program has no services: a command was run against the command line ' +
            'without the application behind it.',
        );
      },
    },
  );
  return placeholder as unknown as T;
}

/** The services of a program that only prints the command line. */
function catalogServices(): CreateCliOptions {
  return {
    db: null,
    runService: notBuilt(),
    manager: notBuilt(),
    engine: notBuilt(),
    outcomeRepo: notBuilt(),
    config: notBuilt(),
    candidateRepo: notBuilt(),
    scoringRepo: notBuilt(),
    trademarkRepo: notBuilt(),
    providerCacheRepo: notBuilt(),
    runsRepo: notBuilt(),
    gate: notBuilt(),
    alertEngine: notBuilt(),
    alertRepo: notBuilt(),
    scheduler: notBuilt(),
    jobQueueService: notBuilt(),
    watchlistService: notBuilt(),
    currentWeights: notBuilt(),
    purchaseService: notBuilt(),
    reportService: notBuilt(),
    accuracyAnalyzer: notBuilt(),
    acquisitionService: notBuilt(),
    funnelService: notBuilt(),
    listingManager: notBuilt(),
    postAcquisitionService: notBuilt(),
    keyManager: notBuilt(),
    apiKeyRepo: notBuilt(),
    provider: notBuilt(),
  };
}

/**
 * The command line without the application.
 *
 * `dominus --help` and `dominus --version` are answered from this
 * program: they are the two questions a user asks before deciding whether
 * the tool is worth using, and they must not cost a database, a job
 * worker and a resolver probe. The commands and their descriptions come
 * from the same registration functions as the real program, so the help
 * cannot drift from it.
 */
export function createCatalogCli(): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version(loadCliVersion());

  registerCommands(program, catalogServices(), true);

  return program;
}

export function createCli(options: CreateCliOptions): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version(loadCliVersion());

  registerCommands(program, options, false);

  return program;
}

/**
 * Register every command.
 *
 * The same function builds the real program and the catalog (the program
 * that only prints the command line): the commands, their options and
 * their descriptions come from one place, so the help a user reads is the
 * help the tool has.
 *
 * `catalog` is true when there is no application behind the program: the
 * services are placeholders that fail loudly if a command is run, and the
 * scheduler's job catalogue is not registered (there is no database to
 * register it in).
 */
function registerCommands(program: Command, options: CreateCliOptions, catalog: boolean): void {
  const {
    db,
    runService,
    manager,
    engine,
    outcomeRepo,
    config,
    candidateRepo,
    scoringRepo,
    trademarkRepo,
    providerCacheRepo,
    runsRepo,
    gate,
    alertEngine,
    alertRepo,
    scheduler,
    jobQueueService,
    watchlistService,
    currentWeights,
    purchaseService,
  } = options;

  registerRunCommand(program, {
    runService,
    funnelService: options.funnelService,
    jobQueueService,
    runsRepo,
  });
  registerCandidatesCommand(program, { candidateRepo });
  registerPortfolioCommand(program, { manager, alertEngine, alertRepo, jobQueueService });
  registerScoreCommand(program, engine, gate);
  registerOutcomeCommand(program, outcomeRepo);
  registerBacktestCommand(program, { db, outcomeRepo, currentWeights });
  registerRunsCommand(program, { runsRepo, jobQueueService });
  const backupProvider = db ? new SqliteProvider(db) : undefined;
  // The backup service is SQLite-only (VACUUM INTO). In PostgreSQL mode
  // there is no provider to back up, so there is no service: the command
  // refuses with a clear message instead of dereferencing a missing
  // provider.
  const backupService = backupProvider
    ? new BackupService({
        provider: backupProvider,
        backupDir: config.BACKUP_DIR,
        retentionDays: config.BACKUP_RETENTION_DAYS,
      })
    : undefined;
  registerMaintenanceCommand(program, {
    db,
    trademarkRepo,
    providerCacheRepo,
    runsRepo,
    candidateRepo,
    scoringRepo,
    usageRepo: backupProvider ? new UsageRepository(backupProvider) : undefined,
    backupService,
  });
  registerProvidersCommand(program, { config });
  registerHealthCommand(program, { db, config, provider: options.provider });
  if (scheduler) {
    // The job catalogue is created by the scheduler's start(), which only
    // the long-running scheduler process calls. The CLI needs it for
    // `dominus scheduler status` and `dominus scheduler run <job>`, so it
    // registers the definitions here — WITHOUT arming the cron timers: a
    // manual one-shot run must not leave a schedule behind.
    //
    // The catalog program has no database to register the jobs in.
    if (!catalog) scheduler.registerJobs();
    registerSchedulerCommand(program, { scheduler });
  }

  if (watchlistService) {
    registerWatchlistCommand(program, { watchlistService });
  }

  if (purchaseService) {
    registerBuyCommand(program, { purchaseService });
    registerRegistrarsCommand(program, { activeRegistrar: purchaseService.registrarName });
  }

  if (options.reportService) {
    registerReportCommand(program, { reportService: options.reportService });
  }

  if (options.accuracyAnalyzer) {
    registerAnalyticsCommand(program, { accuracyAnalyzer: options.accuracyAnalyzer });
  }

  if (options.acquisitionService) {
    registerBidCommand(program, { acquisitionService: options.acquisitionService });
  }

  if (options.funnelService) {
    registerFunnelCommand(program, { funnelService: options.funnelService });
  }

  if (options.listingManager) {
    registerListingCommand(program, { listingManager: options.listingManager });
  }

  if (options.postAcquisitionService) {
    registerAutomateCommand(program, {
      postAcquisitionService: options.postAcquisitionService,
    });
  }

  registerKeysCommand(program, {
    keyManager: options.keyManager,
    apiKeyRepo: options.apiKeyRepo,
  });

  if (options.provider) {
    registerTenantCommand(program, { provider: options.provider });
  }
}
