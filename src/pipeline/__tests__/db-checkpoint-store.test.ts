// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { runMigrations } from '../../db/migrator.js';
import { DbCheckpointStore, getResumeIndex } from '../db-checkpoint-store.js';
import { CandidateSource, CandidateStatus, type DomainCandidate } from '../../types/candidate.js';

function cand(domain: string): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'run-1',
  };
}

describe('DbCheckpointStore', () => {
  let sqlite: Database.Database;
  let provider: SqliteProvider;
  let store: DbCheckpointStore;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    provider = new SqliteProvider(sqlite);
    store = new DbCheckpointStore(provider);
  });

  afterEach(async () => {
    await provider.close();
  });

  it('saves and reloads a checkpoint, resuming after the last completed stage', async () => {
    await store.save('run-1', 'DnsPreFilterStage', [cand('a.com'), cand('b.com')], [cand('c.com')]);
    await store.save('run-1', 'RdapConfirmationStage', [cand('a.com')], [cand('b.com')]);

    expect(await store.hasCheckpoint('run-1')).toBe(true);
    expect(await store.hasCheckpoint('run-2')).toBe(false);
    expect(await store.getLastCompletedStage('run-1')).toBe('RdapConfirmationStage');
    expect(getResumeIndex('RdapConfirmationStage')).toBe(3);

    const data = await store.load('run-1');
    expect(data?.lastCompletedStage).toBe('RdapConfirmationStage');
    expect(data?.passed.map((c) => c.domain)).toEqual(['a.com']);
    expect(data?.filtered.map((c) => c.domain)).toEqual(['c.com', 'b.com']);
  });

  it('re-saves a stage without duplicating rows and supports clear', async () => {
    await store.save('run-1', 'DnsPreFilterStage', [], []);
    await store.save('run-1', 'DnsPreFilterStage', [cand('a.com')], []);
    expect(await store.getLastCompletedStage('run-1')).toBe('DnsPreFilterStage');

    await store.clear('run-1');
    expect(await store.hasCheckpoint('run-1')).toBe(false);
  });

  it('returns no checkpoint for an unknown run', async () => {
    expect(await store.load('nope')).toBeNull();
    expect(await store.getLastCompletedStage('nope')).toBeNull();
  });
});
