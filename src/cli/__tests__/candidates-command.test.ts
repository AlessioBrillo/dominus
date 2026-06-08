import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCandidatesCommand } from '../commands/candidates-command.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { DomainCandidate } from '../../types/candidate.js';

function makeMockRepo(rows: DomainCandidate[] = []): CandidateRepository {
  return {
    findAll: vi.fn().mockReturnValue(rows),
  } as unknown as CandidateRepository;
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = original;
  }).then((): string => buffer);
}

const sampleRows: DomainCandidate[] = [
  {
    id: 1,
    domain: 'example.com',
    tld: 'com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Recommended,
    dnsStatus: 'available',
    rdapStatus: 'confirmed',
    isPremium: false,
    pipelineRunId: 'run-uuid-1',
    createdAt: '2025-01-15T10:00:00.000Z',
    updatedAt: '2025-01-15T10:05:00.000Z',
  },
  {
    id: 2,
    domain: 'premium-domain.ai',
    tld: 'ai',
    source: CandidateSource.CloseoutCsv,
    status: CandidateStatus.Scored,
    isPremium: true,
    pipelineRunId: 'run-uuid-1',
    createdAt: '2025-01-15T10:00:00.000Z',
    updatedAt: '2025-01-16T12:00:00.000Z',
  },
];

describe('registerCandidatesCommand', () => {
  it('registers a "candidates" command on the program', () => {
    const program = new Command();
    registerCandidatesCommand(program, { candidateRepo: makeMockRepo() });
    const cmd = program.commands.find((c) => c.name() === 'candidates');
    expect(cmd).toBeDefined();
  });

  it('prints empty array JSON when no candidates and --json', async () => {
    const program = new Command();
    program.exitOverride();
    registerCandidatesCommand(program, { candidateRepo: makeMockRepo() });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'candidates', 'list', '--json']);
    });
    expect(out).toBe('[]\n');
  });

  it('prints a message when no candidates and no --json', async () => {
    const program = new Command();
    program.exitOverride();
    registerCandidatesCommand(program, { candidateRepo: makeMockRepo() });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'candidates', 'list']);
    });
    expect(out).toContain('No candidates recorded yet');
  });

  it('prints a table when candidates exist', async () => {
    const program = new Command();
    program.exitOverride();
    registerCandidatesCommand(program, { candidateRepo: makeMockRepo(sampleRows) });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'candidates', 'list']);
    });
    expect(out).toContain('example.com');
    expect(out).toContain('premium-domain.ai');
    expect(out).toContain('ID  DOMAIN');
  });

  it('emits JSON array when --json is passed and rows exist', async () => {
    const program = new Command();
    program.exitOverride();
    registerCandidatesCommand(program, { candidateRepo: makeMockRepo(sampleRows) });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'candidates', 'list', '--json']);
    });
    const parsed = JSON.parse(out) as DomainCandidate[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.domain).toBe('example.com');
    expect(parsed[1]?.domain).toBe('premium-domain.ai');
  });

  it('passes --limit n to findAll', async () => {
    const repo = makeMockRepo(sampleRows);
    const program = new Command();
    program.exitOverride();
    registerCandidatesCommand(program, { candidateRepo: repo });

    await program.parseAsync(['node', 'dominus', 'candidates', 'list', '--limit', '10']);
    expect((repo.findAll as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(10);
  });
});
