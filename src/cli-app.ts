#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLogDestination } from './logger.js';
import { loadConfig } from './config.js';
import { createDependencies } from './app/composition-root.js';
import { createDecisionDependencies } from './app/decision-root.js';
import { createCatalogCli, createCli, createDecisionCli } from './cli/index.js';
import { registerDoctorCommand } from './cli/commands/doctor-command.js';
import { resolveCliProfile } from './cli/profile.js';
import { closeDatabase } from './db/database.js';
import type { KeyManager } from './providers/auth/auth-provider.js';

function readCliVersion(): string {
  try {
    // Resolve the package.json from this module's location, not from the
    // caller's working directory: the installed CLI must report its own
    // version regardless of where the user runs it from.
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
        'utf-8',
      ),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  // stdout is the command's OUTPUT channel: the decision a command prints.
  // The logs are diagnostics and belong on stderr, so that
  // `dominus score example.com | jq` reads the decision and nothing else.
  setLogDestination('stderr');

  // Four profiles, resolved before anything is built: building the full
  // application opens the database, applies the migrations, starts the job
  // worker and probes the resolver. A command that only answers a question
  // about a domain must not pay for any of that, and a command that only
  // prints the command line must not pay for anything at all. The
  // diagnostic profile inspects an installation without mutating it.
  const profile = resolveCliProfile(process.argv);

  if (profile === 'catalog') {
    const catalog = createCatalogCli();
    await catalog.parseAsync(process.argv);
    return;
  }

  if (profile === 'diagnostic') {
    // Read-only diagnostic profile: opens SQLite without running migrations,
    // without starting the worker, and without probing external services.
    // Used by `dominus doctor` so the command never mutates the database.
    const config = loadConfig();
    let db: Database.Database | null = null;
    if (!config.DATABASE_URL) {
      try {
        db = new Database(config.DATABASE_PATH, { readonly: true });
      } catch {
        // No database yet: doctor still runs its read-only checks and
        // reports the missing database as a fail check instead of crashing
        // with a raw SQLite stack trace.
        db = null;
      }
    }
    const program = new Command();
    program
      .name('dominus')
      .description('Personal DNS domain investment decision-support tool')
      .version(readCliVersion());
    registerDoctorCommand(program, { db, config });
    await program.parseAsync(process.argv);
    db?.close();
    return;
  }

  const config = loadConfig();

  if (profile === 'decision') {
    const decision = createDecisionDependencies(config);
    const cli = createDecisionCli({
      config,
      engine: decision.engine,
      gate: decision.gate,
    });
    await cli.parseAsync(process.argv);
    return;
  }

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
    gate: deps.trademarkGate,
    alertEngine: deps.alertEngine,
    alertRepo: deps.alertRepo,
    scheduler: deps.scheduler,
    jobQueueService: deps.jobQueueService,
    watchlistService: deps.watchlistService,
    currentWeights: deps.currentWeights,
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
  // and then hung - `dominus keys create` returned the key and never
  // exited.
  //
  // The in-process job worker (ADR-0023: the CLI runs the queued jobs
  // itself) is stopped first, so that no poll is in flight when the
  // database goes away.
  await deps.worker?.stop();
  await deps.redisClient?.shutdown();

  // The read and the write providers are SEPARATE pools (ADR-0080): each
  // one keeps its own sockets open. Closing only the main provider left
  // those sockets behind, and the one-shot CLI never exited: the command
  // printed its output and the process hung until it was killed. The API
  // server closes all three (src/index.ts, step 6); the CLI must do the
  // same.
  if (deps.writeProvider && deps.writeProvider !== deps.provider) {
    await deps.writeProvider.close();
  }
  if (deps.readProvider && deps.readProvider !== deps.provider) {
    await deps.readProvider.close();
  }

  await deps.provider.close();
  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
