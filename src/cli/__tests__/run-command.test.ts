import { describe, it, expect, vi } from 'vitest';
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
});
