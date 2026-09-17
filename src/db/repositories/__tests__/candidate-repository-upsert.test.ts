// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { CandidateRepository } from '../candidate-repository.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import type { VerdictProvenance } from '../../../types/domain-status.js';

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

  it('inserts a new candidate and returns it with an id', async () => {
    // Arrange
    const candidate = makeCandidate('example.com');

    // Act
    const result = await repo.upsert(candidate);

    // Assert
    expect(result.id).toBeTypeOf('number');
    expect(result.id).toBeGreaterThan(0);
    expect(result.domain).toBe('example.com');
  });

  it('does not throw on a second upsert of the same domain', async () => {
    // Arrange
    const candidate = makeCandidate('example.com');
    await repo.upsert(candidate);

    // Act + Assert — no UNIQUE constraint error
    await repo.upsert({ ...candidate, status: CandidateStatus.Scored });
  });

  it('updates mutable fields on conflict', async () => {
    // Arrange
    const original = makeCandidate('example.com', { status: CandidateStatus.Pending });
    const first = await repo.upsert(original);

    // Act — same domain, new run with updated status
    const updated = await repo.upsert({
      ...original,
      status: CandidateStatus.Recommended,
      pipelineRunId: 'run-002',
    });

    // Assert — same row id, status updated
    expect(updated.id).toBe(first.id);
    const row = await repo.findById(first.id!);
    expect(row?.status).toBe(CandidateStatus.Recommended);
    expect(row?.pipelineRunId).toBe('run-002');
  });

  it('produces exactly one row for multiple upserts of the same domain', async () => {
    // Arrange
    const candidate = makeCandidate('example.com');

    // Act
    await repo.upsert(candidate);
    await repo.upsert(candidate);
    await repo.upsert(candidate);

    // Assert
    const rows = provider.rawDb
      .prepare('SELECT COUNT(*) as cnt FROM candidates WHERE domain = ?')
      .get('example.com') as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('persists dns_status and rdap_status correctly', async () => {
    // Arrange
    const candidate = makeCandidate('example.com', {
      dnsStatus: 'available',
      rdapStatus: 'available',
      status: CandidateStatus.Scored,
    });

    // Act
    const result = await repo.upsert(candidate);
    const row = await repo.findById(result.id!);

    // Assert
    expect(row?.dnsStatus).toBe('available');
    expect(row?.rdapStatus).toBe('available');
  });

  it('round-trips verdictProvenance through JSON persistence', async () => {
    // Arrange
    const verdictProvenance: VerdictProvenance = {
      dns: {
        resolver: 'UnboundResolver',
        transport: 'native',
        dnssec: 'valid',
        durationMs: 42,
        fromCache: false,
      },
      rdap: {
        primaryServer: 'https://rdap.verisign.com',
        consensus: {
          secondServer: 'https://rdap.org',
          verified: true,
          vetoed: false,
          originOverlap: false,
          whoisRescued: false,
        },
        durationMs: 210,
      },
      timestamp: '2026-09-17T00:00:00.000Z',
    };
    const candidate = makeCandidate('example.com', { verdictProvenance });

    // Act
    const result = await repo.upsert(candidate);
    const row = await repo.findById(result.id!);

    // Assert
    expect(row?.verdictProvenance).toEqual(verdictProvenance);
  });

  it('degrades a corrupted verdict_provenance column to undefined instead of throwing', async () => {
    // Arrange
    const candidate = makeCandidate('example.com');
    const inserted = await repo.upsert(candidate);
    provider.rawDb
      .prepare('UPDATE candidates SET verdict_provenance = ? WHERE id = ?')
      .run('{not valid json', inserted.id);

    // Act
    const row = await repo.findById(inserted.id!);

    // Assert
    expect(row?.verdictProvenance).toBeUndefined();
  });

  it('leaves verdictProvenance undefined when the candidate carries none', async () => {
    // Arrange
    const candidate = makeCandidate('example.com');

    // Act
    const result = await repo.upsert(candidate);
    const row = await repo.findById(result.id!);

    // Assert
    expect(row?.verdictProvenance).toBeUndefined();
  });
});
