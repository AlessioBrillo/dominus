#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { getLogger } from './logger.js';
import { createHealthcheckServer } from './utils/healthcheck-server.js';

const logger = getLogger();

const HEALTHCHECK_PORT = 9090;

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

  // Start healthcheck HTTP server on loopback (port 9090, never 0.0.0.0).
  // Docker HEALTHCHECK hits this endpoint to verify the worker is actually
  // polling and processing jobs, not just the process existing.
  const healthcheck = createHealthcheckServer({
    port: HEALTHCHECK_PORT,
    label: 'worker',
    check: async () => {
      const status = worker.getStatus();
      return status.running;
    },
  });

  logger.info(
    { healthcheckPort: HEALTHCHECK_PORT },
    'Worker entrypoint: JobWorker started successfully',
  );

  // Graceful shutdown — resolve the keepalive promise instead of calling
  // process.exit(0), allowing the event loop to drain naturally.  In K8s
  // the terminationGracePeriodSeconds still bounds total shutdown time;
  // if worker.stop() exceeds the window, SIGKILL takes over.
  let shutdownComplete: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownComplete = resolve;
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker entrypoint: received shutdown signal');
    healthcheck.close();
    await worker.stop();
    shutdownComplete();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await shutdownPromise;
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker entrypoint: fatal error');
  process.exit(1);
});
