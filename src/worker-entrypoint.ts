#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { getLogger } from './logger.js';

const logger = getLogger();

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.WORKER_ENABLED) {
    logger.warn(
      'Worker entrypoint started but WORKER_ENABLED=false. ' +
        'Set WORKER_ENABLED=true in the environment to start the job worker.',
    );
    process.exit(0);
  }

  const deps = await createDependencies(config);
  const worker = deps.worker;

  if (!worker) {
    logger.error('Worker entrypoint: JobWorker failed to initialise — check configuration');
    process.exit(1);
  }

  logger.info('Worker entrypoint: JobWorker started successfully');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker entrypoint: received shutdown signal');
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker entrypoint: fatal error');
  process.exit(1);
});
