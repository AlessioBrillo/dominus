// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The catalog program.
//
// `dominus --help` and `dominus --version` are the two questions a user
// asks before deciding whether the tool is worth using. Answering them
// used to cost the whole application: a database, its migrations, a job
// worker and a resolver probe - ten seconds to print a list of commands.
//
// The catalog answers them without any of that. The risk of a second
// program is that it drifts from the real one, so the two are compared
// here: the catalog must list exactly the commands the real program has.
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { createCatalogCli, createCli } from '../index.js';

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name()).sort();
}

/** The real program, with the smallest services that let it be built. */
function realProgram(): Command {
  return createCli({
    db: null,
    runService: {} as never,
    manager: {} as never,
    engine: {} as never,
    outcomeRepo: {} as never,
    config: {} as never,
    candidateRepo: {} as never,
    scoringRepo: {} as never,
    trademarkRepo: {} as never,
    runsRepo: {} as never,
    scheduler: { registerJobs: (): void => {} } as never,
    purchaseService: { registrarName: 'manual' } as never,
    reportService: {} as never,
    accuracyAnalyzer: {} as never,
    acquisitionService: {} as never,
    funnelService: {} as never,
    listingManager: {} as never,
    postAcquisitionService: {} as never,
    provider: {} as never,
    // The optional services decide whether their command is registered at
    // all, so the real program needs them to have the full command line.
    providerCacheRepo: {} as never,
    gate: {} as never,
    alertEngine: {} as never,
    alertRepo: {} as never,
    jobQueueService: {} as never,
    watchlistService: {} as never,
    currentWeights: {} as never,
    keyManager: {} as never,
    apiKeyRepo: {} as never,
  });
}

describe('the catalog program', () => {
  it('lists exactly the commands the real program has', () => {
    const catalog = commandNames(createCatalogCli());
    const real = commandNames(realProgram());
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog).toEqual(real);
  });

  it('prints the command line without reading a service', async () => {
    // The catalog has no services: reading one would throw. Printing the
    // help must not read any.
    const program = createCatalogCli();
    const original = process.stdout.write.bind(process.stdout);
    let buffer = '';
    (process.stdout.write as unknown) = (chunk: unknown): boolean => {
      buffer += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    const originalExit = process.exit;
    (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
      throw new Error(`__exit:${code}`);
    }) as never;
    try {
      await program.parseAsync(['node', 'dominus', '--help']);
    } catch {
      // commander exits after printing the help.
    } finally {
      process.stdout.write = original;
      (process as unknown as { exit: (code: number) => never }).exit = originalExit;
    }

    expect(buffer).toMatch(/score/);
    expect(buffer).toMatch(/Commands:/);
  });
});
