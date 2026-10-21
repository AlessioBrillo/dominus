#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { createCli } from './cli/index.js';
import { closeDatabase } from './db/database.js';
import type { KeyManager } from './providers/auth/auth-provider.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await createDependencies(config);
  const cli = createCli({
    db: deps.db,
    runService: deps.runService,
    manager: deps.portfolioManager,
    engine: deps.engine,
    outcomeRepo: deps.outcomeRepo,
    config: deps.config,
    candidateRepo: deps.candidateRepo,
    scoringRepo: deps.scoringRepo,
    trademarkRepo: deps.trademarkRepo,
    providerCacheRepo: deps.providerCacheRepo,
    runsRepo: deps.pipelineRunsRepo,
    currentWeights: deps.currentWeights,
    gate: deps.trademarkGate,
    alertEngine: deps.alertEngine,
    alertRepo: deps.alertRepo,
    scheduler: deps.scheduler,
    jobQueueService: deps.jobQueueService,
    reportService: deps.reportService,
    accuracyAnalyzer: deps.accuracyAnalyzer,
    acquisitionService: deps.acquisitionService,
    funnelService: deps.funnelService,
    listingManager: deps.listingManager,
    postAcquisitionService: deps.postAcquisitionService,
    keyManager: deps.authProvider.asKeyManager() as KeyManager | undefined,
    apiKeyRepo: deps.apiKeyRepo,
    provider: deps.provider,
  });

  // parseAsync, not parse: the actions are asynchronous, and the resources
  // below may only be released once the action has finished.
  await cli.parseAsync(process.argv);

  // The CLI is a one-shot process. It must release the connection pool
  // and the Redis client before returning to the shell: in PostgreSQL mode
  // they keep the event loop alive, so every command printed its output
  // and then hung — `dominus keys create` returned the key and never
  // exited.
  //
  // The in-process job worker (ADR-0023: the CLI runs the queued jobs
  // itself) is stopped first, so that no poll is in flight when the
  // database goes away.
  await deps.worker?.stop();
  await deps.redisClient?.shutdown();
  await deps.provider.close();
  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
