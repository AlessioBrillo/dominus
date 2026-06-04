import type { Command } from 'commander';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';

export function registerRunCommand(program: Command, runService: PipelineRunService): void {
  program
    .command('run')
    .description('Run the evaluation pipeline for a set of domain candidates')
    .option('-k, --keywords <keywords>', 'Comma-separated keywords to evaluate as .com names')
    .option('-b, --brandable <domains>', 'Comma-separated brandable domain names')
    .option('-c, --closeout <domains>', 'Comma-separated closeout/expired domain names')
    .action((options: { keywords?: string; brandable?: string; closeout?: string }) => {
      const keywords = options.keywords?.split(',').map((k) => k.trim()).filter(Boolean);
      const brandableNames = options.brandable?.split(',').map((k) => k.trim()).filter(Boolean);
      const closeoutDomains = options.closeout?.split(',').map((k) => k.trim()).filter(Boolean);

      runService
        .run({ keywords, brandableNames, closeoutDomains })
        .then((result) => {
          process.stdout.write(`\nPipeline run: ${result.runId}\n`);
          process.stdout.write(`Duration: ${result.totalDurationMs}ms\n\n`);

          if (result.recommended.length === 0) {
            process.stdout.write('No recommended candidates found.\n');
          } else {
            process.stdout.write(`Recommended (${result.recommended.length}):\n`);
            for (const c of result.recommended) {
              const score = c.scoreResult;
              process.stdout.write(
                `  ${c.domain.padEnd(30)} EV: €${score.expectedValue.toFixed(0).padStart(6)}  Buy≤: €${score.suggestedBuyMax.toFixed(0).padStart(5)}  conf: ${(score.confidence * 100).toFixed(0)}%\n`,
              );
            }
          }

          // Persistence summary — confirms every run is durable.
          const { candidatesPersisted, scoresPersisted } = result.persistence;
          process.stdout.write(
            `\nPersisted ${candidatesPersisted} candidates, ${scoresPersisted} scores → ${process.env['DATABASE_PATH'] ?? './data/dominus.db'}\n`,
          );
        })
        .catch((err: unknown) => {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
    });
}
