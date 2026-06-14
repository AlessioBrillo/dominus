import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerRunCommand } from '../commands/run-command.js';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';

function makeMockRunService(): PipelineRunService {
  return {
    run: vi.fn().mockResolvedValue({
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
    registerRunCommand(program, makeMockRunService());
    const cmd = program.commands.find((c) => c.name() === 'run');
    expect(cmd).toBeDefined();
  });

  it('calls runService.run with parsed keywords', async () => {
    const runService = makeMockRunService();
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, runService);

    await program.parseAsync(['node', 'cli', 'run', '--keywords', 'nova,saas']);
    expect(runService.run).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['nova', 'saas'] }),
    );
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
    registerRunCommand(program, runService);

    await program.parseAsync(['node', 'cli', 'run', '--closeout-csv', csvPath]);
    expect(runService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        closeoutEntries: [
          { domain: 'expired.com', domainAge: 12, backlinks: 340, waybackSnapshots: 87 },
        ],
      }),
    );
  });
});
