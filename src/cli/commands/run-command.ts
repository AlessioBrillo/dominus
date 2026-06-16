import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { JobQueueService } from '../../app/job-queue-service.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import { parseCloseoutCsv } from '../../candidates/index.js';
import type { CloseoutEntry } from '../../types/candidate.js';

export interface RunCommandDeps {
  runService: PipelineRunService;
  jobQueueService?: JobQueueService | undefined;
  runsRepo?: PipelineRunsRepository | undefined;
}

function buildInput(options: {
  keywords?: string;
  brandable?: string;
  closeout?: string;
  closeoutCsv?: string;
}): {
  keywords: string[] | undefined;
  brandableNames: string[] | undefined;
  closeoutDomains: string[] | undefined;
  closeoutEntries: CloseoutEntry[] | undefined;
} {
  const keywords = options.keywords
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const brandableNames = options.brandable
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const closeoutDomains = options.closeout
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  let closeoutEntries: CloseoutEntry[] | undefined;
  if (options.closeoutCsv !== undefined) {
    const csvPath = resolve(process.cwd(), options.closeoutCsv);
    if (!existsSync(csvPath)) {
      process.stderr.write(`Error: closeout CSV not found: ${csvPath}\n`);
      process.exit(1);
    }
    closeoutEntries = parseCloseoutCsv(readFileSync(csvPath, 'utf-8'));
    process.stdout.write(
      `Imported ${closeoutEntries.length} closeout domains from ${options.closeoutCsv}\n`,
    );
  }

  return { keywords, brandableNames, closeoutDomains, closeoutEntries };
}

function printResult(result: Awaited<ReturnType<PipelineRunService['run']>>): void {
  process.stdout.write(`\nPipeline run: ${result.runId}\n`);
  process.stdout.write(`Duration: ${result.totalDurationMs}ms\n\n`);

  if (result.stageErrors.length > 0) {
    for (const err of result.stageErrors) {
      const providerTag = err.provider ? ` [provider: ${err.provider}]` : '';
      process.stderr.write(
        `\x1b[33m\u26a0 ${err.stageName}: ${err.message}${providerTag}\x1b[0m\n`,
      );
    }
    process.stderr.write('\n');
  }

  if (result.recommended.length === 0) {
    process.stdout.write('No recommended candidates found.\n');
  } else {
    process.stdout.write(`Recommended (${result.recommended.length}):\n`);
    for (const c of result.recommended) {
      const score = c.scoreResult!;
      process.stdout.write(
        `  ${c.domain.padEnd(30)} EV: \u20ac${score.expectedValue.toFixed(0).padStart(6)}  Buy\u2264: \u20ac${score.suggestedBuyMax.toFixed(0).padStart(5)}  conf: ${(score.confidence * 100).toFixed(0)}%\n`,
      );
    }
  }

  const { candidatesPersisted, scoresPersisted } = result.persistence;
  process.stdout.write(
    `\nPersisted ${candidatesPersisted} candidates, ${scoresPersisted} scores \u2192 ${process.env['DATABASE_PATH'] ?? './data/dominus.db'}\n`,
  );
}

function printAsyncResult(runId: string, jobId: string): void {
  process.stdout.write(`\nPipeline submitted asynchronously.\n`);
  process.stdout.write(`  Run ID:  ${runId}\n`);
  process.stdout.write(`  Job ID:  ${jobId}\n`);
  process.stdout.write(`\nTrack progress:\n`);
  process.stdout.write(`  dominus runs show ${runId}\n`);
  process.stdout.write(`  GET /api/v1/runs/${runId}\n`);
}

export function registerRunCommand(program: Command, deps: RunCommandDeps): void {
  const { runService, jobQueueService } = deps;

  const run = program
    .command('run')
    .description('Run the evaluation pipeline for a set of domain candidates')
    .option('-k, --keywords <keywords>', 'Comma-separated keywords to evaluate as .com names')
    .option('-b, --brandable <domains>', 'Comma-separated brandable domain names')
    .option('-c, --closeout <domains>', 'Comma-separated closeout/expired domain names')
    .option(
      '--closeout-csv <path>',
      'Path to a closeout CSV (header: domain,age,backlinks,wayback)',
    )
    .option(
      '--async',
      'Enqueue via job queue and return immediately instead of running synchronously',
      false,
    )
    .option('--wait', 'Enqueue via job queue and poll until completion (implies --async)', false);

  run
    .command('submit')
    .description('Enqueue a pipeline run via the job queue and exit immediately')
    .option('-k, --keywords <keywords>', 'Comma-separated keywords to evaluate as .com names')
    .option('-b, --brandable <domains>', 'Comma-separated brandable domain names')
    .option('-c, --closeout <domains>', 'Comma-separated closeout/expired domain names')
    .option(
      '--closeout-csv <path>',
      'Path to a closeout CSV (header: domain,age,backlinks,wayback)',
    )
    .action(
      (options: {
        keywords?: string;
        brandable?: string;
        closeout?: string;
        closeoutCsv?: string;
      }) => {
        if (!jobQueueService) {
          process.stderr.write(
            'Error: Job queue is not available. Set WORKER_ENABLED=true in environment.\n',
          );
          process.exit(1);
          return;
        }

        const input = buildInput(options);
        void jobQueueService.enqueuePipelineRun(input).then(({ jobId, runId }) => {
          printAsyncResult(runId, jobId);
        });
      },
    );

  run.action(
    (options: {
      keywords?: string;
      brandable?: string;
      closeout?: string;
      closeoutCsv?: string;
      async?: boolean | string;
      wait?: boolean | string;
    }) => {
      const input = buildInput(options);

      const useAsync = Boolean(options.async) || Boolean(options.wait);

      if (useAsync) {
        if (!jobQueueService) {
          process.stderr.write(
            'Error: Job queue is not available. Set WORKER_ENABLED=true in environment.\n',
          );
          process.exit(1);
          return;
        }

        void jobQueueService.enqueuePipelineRun(input).then(({ jobId, runId }) => {
          if (options.wait) {
            process.stdout.write(`Pipeline enqueued (job ${jobId}). Waiting for completion...\n`);
            if (deps.runsRepo) {
              const poll = setInterval(() => {
                if (!deps.runsRepo) return;
                const run = deps.runsRepo.findById(runId);
                if (run !== null && run.finishedAt !== null) {
                  clearInterval(poll);
                  if (run.error) {
                    process.stderr.write(`\nPipeline run ${runId} failed: ${run.error}\n`);
                    process.exit(1);
                  } else {
                    process.stdout.write(`\nPipeline run ${runId} completed successfully.\n`);
                    process.stdout.write(`  Duration: ${run.totalDurationMs}ms\n`);
                    process.stdout.write(`  Recommended: ${run.resultsSummary.recommended}\n`);
                  }
                }
              }, 2000);
            } else {
              process.stdout.write('(progress tracking unavailable — polling job status)\n');
              const parsedJobId = Number(jobId);
              if (!Number.isNaN(parsedJobId)) {
                const poll = setInterval(() => {
                  void jobQueueService!.getJobStatus(parsedJobId).then((status) => {
                    if (!status) return;
                    if (status.job.status === 'completed') {
                      clearInterval(poll);
                      process.stdout.write(`\nPipeline run ${runId} completed.\n`);
                    } else if (status.job.status === 'failed') {
                      clearInterval(poll);
                      process.stderr.write(
                        `\nPipeline run failed: ${status.job.error ?? 'Unknown error'}\n`,
                      );
                      process.exit(1);
                    }
                  });
                }, 2000);
              }
            }
          } else {
            printAsyncResult(runId, jobId);
          }
        });
        return;
      }

      runService
        .run(input)
        .then((result) => {
          printResult(result);
        })
        .catch((err: unknown) => {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
    },
  );
}
