#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { createCli } from './cli/index.js';
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
    dnsConsensusActive: deps.dnsConsensusActive,
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
    keyManager: deps.authProvider.asKeyManager() as KeyManager | undefined,
    apiKeyRepo: deps.apiKeyRepo,
  });
  cli.parse(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
