#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { createCli } from './cli/index.js';

const config = loadConfig();
const deps = createDependencies(config);
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
  listingManager: deps.listingManager,
});
cli.parse(process.argv);
