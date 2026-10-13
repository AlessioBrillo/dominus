// SPDX-License-Identifier: AGPL-3.0-only
import { type Command } from 'commander';
import type { PostAcquisitionService } from '../../services/post-acquisition-service.js';
import {
  POST_ACQUISITION_STEPS,
  isPostAcquisitionStepName,
  isPostAcquisitionTriggerSource,
  type PostAcquisitionStepName,
} from '../../types/automation.js';

const TRIGGER_SOURCES = ['purchase', 'acquisition', 'manual', 'pipeline_run'] as const;

import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface AutomateCommandOptions {
  postAcquisitionService: PostAcquisitionService;
}

export function registerAutomateCommand(program: Command, options: AutomateCommandOptions): void {
  const { postAcquisitionService } = options;

  const automate = program
    .command('automate')
    .description('Post-acquisition automation pipeline (ADR-0083)');

  automate
    .command('settings')
    .description('Show the automation kill switch and dry-run flag')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const settings = postAcquisitionService.settings;
      if (opts.json) {
        console.log(JSON.stringify(settings, null, 2));
        return;
      }
      console.log(`\nAutomation settings:`);
      console.log(`  enabled:  ${settings.enabled ? 'yes' : 'no (kill switch off)'}`);
      console.log(`  dry-run:  ${settings.dryRun ? 'yes' : 'no'}`);
      console.log(
        settings.enabled
          ? settings.dryRun
            ? '  Pipeline runs but money/DNS steps will skip.'
            : '  Pipeline executes steps for real.'
          : '  Every run is refused until AUTOMATION_ENABLED=true.',
      );
    });

  automate
    .command('status [domain]')
    .description('Show pipeline step status, optionally filtered by domain')
    .option('--status <status>', 'Filter by step status (pending, done, skipped, failed)')
    .option('--limit <n>', 'Max rows', '100')
    .option('--json', 'Output as JSON')
    .action(async (domain, opts) => {
      try {
        const steps = domain
          ? await postAcquisitionService.getStatus(domain)
          : await postAcquisitionService.listSteps({
              ...(opts.status ? { status: opts.status } : {}),
              limit: parseInt(opts.limit, 10),
            });

        if (opts.json) {
          console.log(JSON.stringify(steps, null, 2));
          return;
        }

        if (steps.length === 0) {
          console.log('No automation steps found.');
          return;
        }

        console.log('\nPost-acquisition steps:');
        console.log('-'.repeat(104));
        console.log(
          '  Domain                    Step        Status    Attempts  Source        Updated             Error',
        );
        console.log('-'.repeat(104));
        for (const s of steps) {
          const error = s.lastError ? s.lastError.slice(0, 24) : '-';
          const updated = s.updatedAt ? s.updatedAt.substring(0, 19) : '-';
          console.log(
            `  ${s.domain.padEnd(25)} ${s.step.padEnd(10)} ${s.status.padEnd(9)} ${String(s.attempts).padStart(8)}  ${s.source.padEnd(12)} ${updated.padEnd(19)} ${error}`,
          );
        }
        console.log('-'.repeat(104));
        console.log(`Total: ${steps.length}`);
      } catch (err) {
        logger.error({ err }, 'automate status failed');
        process.exitCode = 1;
      }
    });

  automate
    .command('run <domain>')
    .description('Run (or resume) the pipeline for a domain')
    .option(
      '--source <source>',
      'Trigger source (purchase, acquisition, manual, pipeline_run)',
      'manual',
    )
    .option('--pipeline-run <id>', 'Pipeline run id to record')
    .option('--reset', 'Reset all steps before running')
    .action(async (domain, opts) => {
      try {
        if (!isPostAcquisitionTriggerSource(opts.source)) {
          console.error(
            `Unknown trigger source "${opts.source}". Valid: ${TRIGGER_SOURCES.join(', ')}`,
          );
          process.exitCode = 1;
          return;
        }
        const result = opts.reset
          ? await postAcquisitionService.resetAndRun(domain, opts.source)
          : await postAcquisitionService.run(domain, opts.source, {
              ...(opts.pipelineRun ? { pipelineRunId: opts.pipelineRun } : {}),
            });

        if (!result.enabled) {
          console.log(
            'Automation is disabled (AUTOMATION_ENABLED=false). Nothing was executed — set the kill switch to enable.',
          );
          process.exitCode = 1;
          return;
        }

        console.log(
          `\nPipeline ${result.dryRun ? '(dry-run) ' : ''}for ${domain} [source: ${result.source}]:`,
        );
        for (const s of result.steps) {
          const suffix = s.message ? ` — ${s.message}` : '';
          console.log(`  ${s.step.padEnd(10)} ${s.status}${suffix}`);
        }
      } catch (err) {
        logger.error({ err, domain }, 'automate run failed');
        process.exitCode = 1;
      }
    });

  automate
    .command('reset <domain> [step]')
    .description('Reset a step (or the whole pipeline) so it runs again')
    .action(async (domain, step) => {
      try {
        if (step) {
          if (!isPostAcquisitionStepName(step)) {
            console.error(
              `Unknown step "${step}". Valid steps: ${POST_ACQUISITION_STEPS.join(', ')}`,
            );
            process.exitCode = 1;
            return;
          }
          const stepName: PostAcquisitionStepName = step;
          await postAcquisitionService.resetStep(domain, stepName);
          console.log(`Step ${stepName} for ${domain} reset to pending.`);
          return;
        }
        await postAcquisitionService.resetAndRun(domain, 'manual');
      } catch (err) {
        logger.error({ err, domain }, 'automate reset failed');
        process.exitCode = 1;
      }
    });

  automate
    .command('audit')
    .description('Show the automation audit trail')
    .option('--limit <n>', 'Max rows', '50')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const entries = await postAcquisitionService.listAudit(parseInt(opts.limit, 10));
        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log('No audit entries.');
          return;
        }
        console.log('\nAutomation audit:');
        console.log('-'.repeat(104));
        for (const e of entries) {
          const domain = e.domain ?? '-';
          console.log(
            `  ${e.createdAt.substring(0, 19)}  ${e.action.padEnd(28)} ${domain.padEnd(25)} ${e.actor}`,
          );
        }
        console.log('-'.repeat(104));
        console.log(`Total: ${entries.length}`);
      } catch (err) {
        logger.error({ err }, 'automate audit failed');
        process.exitCode = 1;
      }
    });
}
