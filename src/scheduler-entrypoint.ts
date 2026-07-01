#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { getLogger } from './logger.js';
import { createHealthcheckServer } from './utils/healthcheck-server.js';

const logger = getLogger();
const HEALTHCHECK_PORT = 9091;

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.SCHEDULER_ENABLED) {
    logger.warn(
      'Scheduler entrypoint started but SCHEDULER_ENABLED=false. ' +
        'Set SCHEDULER_ENABLED=true in the environment to start the scheduler.',
    );
    process.exit(0);
  }

  const deps = await createDependencies(config);
  const scheduler = deps.scheduler;

  if (!scheduler) {
    logger.error(
      'Scheduler entrypoint: SchedulerService failed to initialise — check configuration',
    );
    process.exit(1);
  }

  const healthcheck = createHealthcheckServer({
    port: HEALTHCHECK_PORT,
    label: 'scheduler',
    check: async () => true,
  });

  logger.info(
    { healthcheckPort: HEALTHCHECK_PORT },
    'Scheduler entrypoint: SchedulerService started successfully',
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Scheduler entrypoint: received shutdown signal');
    healthcheck.close();
    scheduler.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'Scheduler entrypoint: fatal error');
  process.exit(1);
});
