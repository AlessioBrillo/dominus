import type { Command } from 'commander';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';

export interface SchedulerCommandDeps {
  scheduler: SchedulerService;
}

export function registerSchedulerCommand(program: Command, deps: SchedulerCommandDeps): void {
  const scheduler = program.command('scheduler').description('Manage scheduled jobs');

  scheduler
    .command('status')
    .description('Show registered jobs and last run timestamps')
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action(async (options: { json: boolean }) => {
      const jobs = await deps.scheduler.getStatus();
      if (options.json) {
        process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
        return;
      }
      if (jobs.length === 0) {
        process.stdout.write('No scheduled jobs registered.\n');
        return;
      }
      const lines: string[] = [];
      lines.push(['JOB', 'SCHEDULE', 'LAST RUN', 'RESULT'].join('  '));
      for (const j of jobs) {
        lines.push(
          [
            j.name.padEnd(16),
            j.cronExpression.padEnd(12),
            (j.lastRunAt ?? '-').padEnd(24),
            j.lastResult ?? '-',
          ].join('  '),
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    });

  scheduler
    .command('run <job>')
    .description('Execute a job immediately (cron-mode compatible)')
    .action(async (job: string) => {
      try {
        const result = await deps.scheduler.runOnce(job);
        process.stdout.write(result + '\n');
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
