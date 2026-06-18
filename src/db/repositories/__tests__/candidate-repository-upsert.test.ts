import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { CandidateRepository } from '../candidate-repository.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function makeCandidate(domain: string, overrides: Partial<DomainCandidate> = {}): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.CloseoutCsv,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'run-001',
    ...overrides,
  };
}

describe('CandidateRepository.upsert', () => {
  let repo: CandidateRepository;
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
    repo = new CandidateRepository(provider);
  });

  it('inserts a new candidate and returns it with an id', () => {
    // Arrange
    const candidate = makeCandidate('example.com');

    // Act
    const result = repo.upsert(candidate);

    // Assert
    expect(result.id).toBeTypeOf('number');
    expect(result.id).toBeGreaterThan(0);
    expect(result.domain).toBe('example.com');
  });

  it('does not throw on a second upsert of the same domain', () => {
    // Arrange
    const candidate = makeCandidate('example.com');
    repo.upsert(candidate);

    // Act + Assert — no UNIQUE constraint error
    expect(() => repo.upsert({ ...candidate, status: CandidateStatus.Scored })).not.toThrow();
  });

  it('updates mutable fields on conflict', () => {
    // Arrange
    const original = makeCandidate('example.com', { status: CandidateStatus.Pending });
    const first = repo.upsert(original);

    // Act — same domain, new run with updated status
    const updated = repo.upsert({
      ...original,
      status: CandidateStatus.Recommended,
      pipelineRunId: 'run-002',
    });

    // Assert — same row id, status updated
    expect(updated.id).toBe(first.id);
    const row = repo.findById(first.id!);
    expect(row?.status).toBe(CandidateStatus.Recommended);
    expect(row?.pipelineRunId).toBe('run-002');
  });

  it('produces exactly one row for multiple upserts of the same domain', () => {
    // Arrange
    const candidate = makeCandidate('example.com');

    // Act
    repo.upsert(candidate);
    repo.upsert(candidate);
    repo.upsert(candidate);

    // Assert
    const rows = provider.rawDb
      .prepare('SELECT COUNT(*) as cnt FROM candidates WHERE domain = ?')
      .get('example.com') as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('persists dns_status and rdap_status correctly', () => {
    // Arrange
    const candidate = makeCandidate('example.com', {
      dnsStatus: 'available',
      rdapStatus: 'available',
      status: CandidateStatus.Scored,
    });

    // Act
    const result = repo.upsert(candidate);
    const row = repo.findById(result.id!);

    // Assert
    expect(row?.dnsStatus).toBe('available');
    expect(row?.rdapStatus).toBe('available');
  });
});
