#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
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

  // Arm the cron timers. The job catalogue exists as soon as the service is
  // built, but the timers are armed by start(): without this call the
  // scheduler process ran NO scheduled job, ever, for any tenant - the whole
  // platform automation (renewal check, rescore, watchlist poll, prune) was
  // dead in the Cloud while the container reported itself healthy.
  scheduler.start();

  logger.info(
    { healthcheckPort: HEALTHCHECK_PORT },
    'Scheduler entrypoint: SchedulerService started successfully',
  );

  // Graceful shutdown — resolve the keepalive promise instead of calling
  // process.exit(0), allowing the event loop to drain naturally.
  let shutdownComplete: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownComplete = resolve;
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Scheduler entrypoint: received shutdown signal');
    healthcheck.close();
    scheduler.stop();
    // The Redis client reconnects on its own after a disconnect: without
    // closing it, its reconnect timer keeps the event loop alive and the
    // process never exits. The container is then killed by the grace
    // period (exit 137) instead of stopping cleanly.
    if (deps.redisClient) {
      await deps.redisClient.shutdown().catch(() => {});
    }
    // ADR-0080 explicit lifecycle: close write, read, then main.
    if (deps.writeProvider && deps.writeProvider !== deps.provider) {
      await deps.writeProvider.close().catch(() => {});
    }
    if (deps.readProvider && deps.readProvider !== deps.provider) {
      await deps.readProvider.close().catch(() => {});
    }
    if (deps.provider) {
      await deps.provider.close().catch(() => {});
    }
    logger.info('Scheduler entrypoint: database providers closed');
    shutdownComplete();
    // The event loop is not empty yet (the logger, the DNS pool): exit
    // explicitly, like the API server does after its shutdown.
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await shutdownPromise;
}

main().catch((err) => {
  logger.fatal({ err }, 'Scheduler entrypoint: fatal error');
  process.exit(1);
});
