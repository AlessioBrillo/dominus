import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerRunCommand } from '../commands/run-command.js';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';

function makeMockRunService(): PipelineRunService {
  return {
    runSync: vi.fn().mockResolvedValue({
      runId: 'test-run-id',
      recommended: [],
      scored: [],
      allCandidates: [],
      stageSummary: {},
      totalDurationMs: 10,
      persistence: { candidatesPersisted: 0, scoresPersisted: 0 },
    }),
  } as unknown as PipelineRunService;
}

describe('registerRunCommand', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('registers a "run" command on the program', () => {
    const program = new Command();
    registerRunCommand(program, { runService: makeMockRunService() });
    const cmd = program.commands.find((c) => c.name() === 'run');
    expect(cmd).toBeDefined();
  });

  it('also registers a "run submit" subcommand', () => {
    const program = new Command();
    registerRunCommand(program, { runService: makeMockRunService() });
    const run = program.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    const submit = run!.commands.find((c) => c.name() === 'submit');
    expect(submit).toBeDefined();
  });

  it('calls runService.runSync with parsed keywords', async () => {
    const runService = makeMockRunService();
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, { runService });

    await program.parseAsync(['node', 'cli', 'run', '--keywords', 'nova,saas']);
    expect(runService.runSync).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['nova', 'saas'] }),
    );
  });

  it('falls back to sync when job queue is unavailable', async () => {
    const runService = makeMockRunService();
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, { runService });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await program.parseAsync(['node', 'cli', 'run', '--keywords', 'test']);
    expect(runService.runSync).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['test'] }),
    );
    writeSpy.mockRestore();
  });

  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles) rmSync(f, { force: true });
    tmpFiles.length = 0;
    vi.restoreAllMocks();
  });

  it('parses --closeout-csv and forwards closeoutEntries', async () => {
    const csvPath = join(tmpdir(), `dominus-closeout-${Date.now()}.csv`);
    writeFileSync(
      csvPath,
      'domain,age,backlinks,wayback\nexpired.com,12,340,87\nbad domain,1,1,1\n',
    );
    tmpFiles.push(csvPath);

    const runService = makeMockRunService();
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, { runService });

    await program.parseAsync(['node', 'cli', 'run', '--closeout-csv', csvPath]);
    expect(runService.runSync).toHaveBeenCalledWith(
      expect.objectContaining({
        closeoutEntries: [
          { domain: 'expired.com', domainAge: 12, backlinks: 340, waybackSnapshots: 87 },
        ],
      }),
    );
  });
});
