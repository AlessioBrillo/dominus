import { Command } from 'commander';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import { registerRunCommand } from './commands/run-command.js';
import { registerPortfolioCommand } from './commands/portfolio-command.js';
import { registerScoreCommand } from './commands/score-command.js';

export function createCli(
  orchestrator: PipelineOrchestrator,
  manager: PortfolioManager,
  engine: ScoringEngine,
): Command {
  const program = new Command();

  program
    .name('dominus')
    .description('Personal DNS domain investment decision-support tool')
    .version('0.1.0');

  registerRunCommand(program, orchestrator);
  registerPortfolioCommand(program, manager);
  registerScoreCommand(program, engine);

  return program;
}
