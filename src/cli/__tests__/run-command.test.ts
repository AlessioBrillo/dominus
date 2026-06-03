import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerRunCommand } from '../commands/run-command.js';
import type { PipelineOrchestrator } from '../../pipeline/orchestrator.js';

function makeMockOrchestrator(): PipelineOrchestrator {
  return {
    run: vi.fn().mockResolvedValue({
      runId: 'test-run-id',
      recommended: [],
      allCandidates: [],
      stageSummary: {},
      totalDurationMs: 10,
    }),
  } as unknown as PipelineOrchestrator;
}

describe('registerRunCommand', () => {
  it('registers a "run" command on the program', () => {
    const program = new Command();
    registerRunCommand(program, makeMockOrchestrator());
    const cmd = program.commands.find((c) => c.name() === 'run');
    expect(cmd).toBeDefined();
  });

  it('calls orchestrator.run with parsed keywords', async () => {
    const orchestrator = makeMockOrchestrator();
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, orchestrator);

    await program.parseAsync(['node', 'cli', 'run', '--keywords', 'nova,saas']);
    expect(orchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['nova', 'saas'] }),
    );
  });
});
