import { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import type { PipelineRunService } from '../app/pipeline-run-service.js';
import { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type { Config } from '../config.js';
import { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import { TrademarkRepository } from '../db/repositories/trademark-repository.js';
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

export function createCli(
  db: Database.Database,
  runService: PipelineRunService,
  manager: PortfolioManager,
  engine: ScoringEngine,
  outcomeRepo: OutcomeRepository,
  config: Config,
  gate?: TrademarkGate,
): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version('0.2.0');

  registerRunCommand(program, runService);
  registerCandidatesCommand(program, { candidateRepo: new CandidateRepository(db) });
  registerPortfolioCommand(program, manager);
  registerScoreCommand(program, engine, gate);
  registerOutcomeCommand(program, outcomeRepo);
  registerBacktestCommand(program, { db, outcomeRepo });
  registerRunsCommand(program, { runsRepo: new PipelineRunsRepository(db) });
  registerMaintenanceCommand(program, {
    db,
    trademarkRepo: new TrademarkRepository(db),
    runsRepo: new PipelineRunsRepository(db),
  });
  registerProvidersCommand(program, { config });
  registerHealthCommand(program, { db, config });

  return program;
}
