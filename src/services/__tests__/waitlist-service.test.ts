// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { WaitlistSignupRepository } from '../../db/repositories/waitlist-signup-repository.js';
import { WaitlistService } from '../waitlist-service.js';
import type { Mailer } from '../../providers/email/mailer.js';

describe('first-party waitlist', () => {
  let provider: SqliteProvider;
  let repo: WaitlistSignupRepository;
  let sent: Array<{ to: string; text: string }>;
  let mailer: Mailer;

  beforeEach(() => {
    provider = new SqliteProvider(new Database(':memory:'));
    runMigrations(provider.rawDb);
    repo = new WaitlistSignupRepository(provider);
    sent = [];
    mailer = {
      configured: true,
      async send(message): Promise<void> {
        sent.push({ to: String(message.to), text: message.text });
      },
    };
  });

  it('refuses to collect an address when no mailer is configured', async () => {
    const offline = new WaitlistService(
      repo,
      { configured: false, send: vi.fn() },
      undefined,
      undefined,
    );
    expect(offline.canAccept).toBe(false);
    await expect(offline.subscribe('a@example.com', '2026-11-24')).rejects.toThrow(
      'WAITLIST_UNAVAILABLE',
    );
  });

  it('stores the consent version and sends a double opt-in link', async () => {
    const service = new WaitlistService(repo, mailer, 'https://dominus.app', 'privacy@example.it');
    await service.subscribe('A@example.com', '2026-11-24');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('/public/waitlist/confirm?token=');
    expect(sent[0]!.text).toContain('version 2026-11-24');
    expect(await repo.countConfirmed()).toBe(0);
  });

  it('confirms only a matching, single-use token', async () => {
    const service = new WaitlistService(repo, mailer, 'https://dominus.app', undefined);
    await service.subscribe('buyer@example.com', '2026-11-24');
    const match = /token=([0-9a-f]{64})/.exec(sent[0]!.text);
    expect(match).not.toBeNull();
    expect(await service.confirm('0'.repeat(64))).toBe(false);
    expect(await service.confirm(match![1]!)).toBe(true);
    expect(await service.confirm(match![1]!)).toBe(false);
    expect(await repo.countConfirmed()).toBe(1);
  });
});
