import { Command } from 'commander';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { PipelineRunService } from '../app/pipeline-run-service.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import { registerRunCommand } from './commands/run-command.js';
import { registerPortfolioCommand } from './commands/portfolio-command.js';
import { registerScoreCommand } from './commands/score-command.js';
import { registerOutcomeCommand } from './commands/outcome-command.js';

export function createCli(
  runService: PipelineRunService,
  manager: PortfolioManager,
  engine: ScoringEngine,
  outcomeRepo: OutcomeRepository,
): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version('0.1.0');

  registerRunCommand(program, runService);
  registerPortfolioCommand(program, manager);
  registerScoreCommand(program, engine);
  registerOutcomeCommand(program, outcomeRepo);

  return program;
}
