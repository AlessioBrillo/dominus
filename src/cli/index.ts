import { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import type { PipelineRunService } from '../app/pipeline-run-service.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { Config } from '../config.js';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
import type { RenewalAlertRepository } from '../db/repositories/renewal-alert-repository.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { ScoringWeights } from '../scoring/weights.js';
import { registerRunCommand } from './commands/run-command.js';
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
import type { WatchlistService } from '../watchlist/watchlist-service.js';

export interface CreateCliOptions {
  db: Database.Database;
  runService: PipelineRunService;
  manager: PortfolioManager;
  engine: ScoringEngine;
  outcomeRepo: OutcomeRepository;
  config: Config;
  candidateRepo: CandidateRepository;
  trademarkRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
  gate?: TrademarkGate;
  alertEngine?: RenewalAlertEngine;
  alertRepo?: RenewalAlertRepository;
  scheduler: SchedulerService | undefined;
  watchlistService?: WatchlistService;
  currentWeights?: ScoringWeights;
}

export function createCli(options: CreateCliOptions): Command {
  const {
    db,
    runService,
    manager,
    engine,
    outcomeRepo,
    config,
    candidateRepo,
    trademarkRepo,
    runsRepo,
    gate,
    alertEngine,
    alertRepo,
    scheduler,
    watchlistService,
    currentWeights,
  } = options;

  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version('0.2.0');

  registerRunCommand(program, runService);
  registerCandidatesCommand(program, { candidateRepo });
  registerPortfolioCommand(program, { manager, alertEngine, alertRepo });
  registerScoreCommand(program, engine, gate);
  registerOutcomeCommand(program, outcomeRepo);
  registerBacktestCommand(program, { db, outcomeRepo, currentWeights });
  registerRunsCommand(program, { runsRepo });
  registerMaintenanceCommand(program, { db, trademarkRepo, runsRepo });
  registerProvidersCommand(program, { config });
  registerHealthCommand(program, { db, config });
  if (scheduler) {
    registerSchedulerCommand(program, { scheduler });
  }

  if (watchlistService) {
    registerWatchlistCommand(program, { watchlistService });
  }

  return program;
}
