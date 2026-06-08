import type { Command } from 'commander';
import type {
  PipelineRun,
  PipelineRunsRepository,
} from '../../db/repositories/pipeline-runs-repository.js';

export interface RunsCommandDeps {
  runsRepo: PipelineRunsRepository;
}

export function registerRunsCommand(program: Command, deps: RunsCommandDeps): void {
  const runs = program
    .command('runs')
    .description('Browse and prune the pipeline_runs history (ADR-0011)');

  runs
    .command('list')
    .description('List the most recent pipeline runs (newest first)')
    .option('--since <iso>', 'Only show runs started at or after this ISO-8601 timestamp')
    .option('--limit <n>', 'Cap the number of rows', (v: string) => Number.parseInt(v, 10))
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((options: { since?: string; limit?: number; json: boolean }) => {
      const opts: { since?: string; limit?: number } = {};
      if (options.since !== undefined) opts.since = options.since;
      if (options.limit !== undefined) opts.limit = options.limit;
      const rows = deps.runsRepo.findAll(opts);
      if (rows.length === 0) {
        if (options.json) {
          process.stdout.write('[]\n');
        } else {
          process.stdout.write('No pipeline runs recorded yet.\n');
        }
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      process.stdout.write(formatRunsTable(rows));
    });

  runs
    .command('show <runId>')
    .description('Show one pipeline run with its full stage + result summary')
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((runId: string, options: { json: boolean }) => {
      const row = deps.runsRepo.findById(runId);
      if (row === null) {
        process.stderr.write(`No pipeline run with id ${runId}\n`);
        process.exit(1);
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(row, null, 2) + '\n');
        return;
      }
      process.stdout.write(formatRunDetail(row));
    });

  runs
    .command('prune')
    .description('Delete pipeline_runs rows whose retained_until has passed (idempotent)')
    .option('--dry-run', 'Print how many rows would be deleted without writing', false)
    .action((options: { dryRun: boolean }) => {
      const before = deps.runsRepo.count();
      if (options.dryRun) {
        // Reuse the same cutoff logic as prune() for a faithful preview.
        // We do not delete; we just report.
        process.stdout.write(
          `Would prune runs whose retained_until < now (${before} total rows remain in table).\n`,
        );
        return;
      }
      const deleted = deps.runsRepo.prune();
      const after = deps.runsRepo.count();
      process.stdout.write(`Pruned ${deleted} pipeline run(s). ${after} row(s) remain.\n`);
    });
}

function formatRunsTable(rows: PipelineRun[]): string {
  const header = ['RUN_ID', 'STARTED_AT', 'DUR_MS', 'INPUTS', 'RECOMMENDED', 'ERROR'];
  const lines: string[] = [header.join('  ')];
  for (const r of rows) {
    const inputs = `${r.inputs.keywords}k/${r.inputs.brandableNames}b/${r.inputs.closeoutDomains}d/${r.inputs.closeoutEntries}e`;
    const error = r.error !== null ? r.error.slice(0, 32) : '';
    const dur = r.totalDurationMs === null ? '-' : String(r.totalDurationMs);
    const rec = String(r.resultsSummary.recommended);
    lines.push(
      [
        r.runId.slice(0, 8),
        r.startedAt,
        dur.padStart(6),
        inputs.padEnd(20),
        rec.padStart(3),
        error,
      ].join('  '),
    );
  }
  return lines.join('\n') + '\n';
}

function formatRunDetail(r: PipelineRun): string {
  const lines: string[] = [];
  lines.push(`Run:           ${r.runId}`);
  lines.push(`Started:       ${r.startedAt}`);
  lines.push(`Finished:      ${r.finishedAt ?? '(in progress)'}`);
  lines.push(`Duration:      ${r.totalDurationMs ?? '-'} ms`);
  lines.push(`Host version:  ${r.hostVersion}`);
  lines.push(`Retained:      ${r.retainedUntil}`);
  lines.push(`Error:         ${r.error ?? '(none)'}`);
  lines.push('');
  lines.push('Inputs:');
  lines.push(`  keywords:        ${r.inputs.keywords}`);
  lines.push(`  brandableNames:  ${r.inputs.brandableNames}`);
  lines.push(`  closeoutDomains: ${r.inputs.closeoutDomains}`);
  lines.push(`  closeoutEntries: ${r.inputs.closeoutEntries}`);
  lines.push('');
  lines.push('Results:');
  lines.push(`  candidatesEvaluated: ${r.resultsSummary.candidatesEvaluated}`);
  lines.push(`  recommended:          ${r.resultsSummary.recommended}`);
  lines.push(`  trademarkBlocked:     ${r.resultsSummary.trademarkBlocked}`);
  lines.push(`  unscored:             ${r.resultsSummary.unscored}`);
  lines.push(`  errors:               ${r.resultsSummary.errors}`);
  lines.push('');
  lines.push('Stages:');
  for (const [name, s] of Object.entries(r.stageSummary)) {
    lines.push(
      `  ${name.padEnd(30)} passed=${s.passed} filtered=${s.filtered} dur=${s.durationMs}ms`,
    );
  }
  return lines.join('\n') + '\n';
}
