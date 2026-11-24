// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { MagicLinkService } from '../magic-link-service.js';
import type { TeamSeatsRepository } from '../../db/repositories/team-seats-repository.js';
import type { MagicLinkTokenRepository } from '../../db/repositories/magic-link-token-repository.js';
import type { IdentityTenantResolver } from '../identity-tenant-resolver.js';
import type { Mailer } from '../../providers/email/mailer.js';

interface Stored {
  id: number;
  tenantId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
}

interface TestDeps {
  service: MagicLinkService;
  tokens: Stored[];
  sent: Array<{ to: string; subject: string; text: string }>;
  mintSession: ReturnType<typeof vi.fn>;
  resolver: IdentityTenantResolver;
  mailer: Mailer;
  setVerified: (value: boolean) => boolean;
}

function makeDeps(): TestDeps {
  const tokens: Stored[] = [];
  let nextId = 1;
  const tokenRepo = {
    create: vi.fn(async (input: Omit<Stored, 'id' | 'consumedAt'>) => {
      const record = { ...input, id: nextId++, consumedAt: null };
      tokens.push(record);
      return record;
    }),
    findByTokenHash: vi.fn(async (hash: string) => tokens.find((t) => t.tokenHash === hash)),
    consume: vi.fn(async (id: number) => {
      const record = tokens.find((t) => t.id === id);
      if (!record || record.consumedAt !== null) return false;
      record.consumedAt = new Date().toISOString();
      return true;
    }),
    deleteById: vi.fn(async (id: number) => {
      const index = tokens.findIndex((t) => t.id === id);
      if (index >= 0) tokens.splice(index, 1);
    }),
  } as unknown as MagicLinkTokenRepository;

  let verifiedSeat = true;
  const seats = {
    findActiveByUserId: vi.fn(async () => []),
    findActiveVerifiedByEmail: vi.fn(async () =>
      verifiedSeat
        ? [
            {
              tenantId: 'tenant-1',
              userId: 'owner@example.com',
              role: 'admin',
              status: 'active',
            },
          ]
        : [],
    ),
  } as unknown as TeamSeatsRepository;

  const resolver = {
    resolve: vi.fn(async () => ({ tenantId: 'tenant-1', role: 'admin' })),
  } as unknown as IdentityTenantResolver;

  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mailer: Mailer = {
    configured: true,
    send: vi.fn(async (message) => {
      sent.push(message);
    }),
  };

  const mintSession = vi.fn(async () => 'signed.jwt.value');

  const service = new MagicLinkService({
    tokens: tokenRepo,
    seats,
    resolver,
    mailer,
    appUrl: 'https://dominus.example',
    ttlMinutes: 15,
    mintSession,
  });

  return {
    service,
    tokens,
    sent,
    mintSession,
    resolver,
    mailer,
    setVerified: (value: boolean): boolean => (verifiedSeat = value),
  };
}

function extractToken(text: string): string {
  const match = /token=([^\s]+)/.exec(text);
  if (!match) throw new Error('no token in email');
  return decodeURIComponent(match[1]!);
}

describe('MagicLinkService', () => {
  it('does not offer a flow without a mail transport', () => {
    const deps = makeDeps();
    const service = new MagicLinkService({
      tokens: {} as MagicLinkTokenRepository,
      seats: {} as TeamSeatsRepository,
      resolver: {} as IdentityTenantResolver,
      mailer: { configured: false, send: vi.fn() },
      appUrl: 'https://dominus.example',
      ttlMinutes: 15,
      mintSession: vi.fn(),
    });
    expect(service.enabled).toBe(false);
    expect(deps.service.enabled).toBe(true);
  });

  it('sends a hashed, expiring, single-use link only to a verified seat', async () => {
    const deps = makeDeps();
    await deps.service.request('Owner@Example.com');

    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.to).toBe('owner@example.com');
    expect(deps.tokens).toHaveLength(1);
    expect(deps.tokens[0]!.tokenHash).not.toContain('token=');
    expect(Date.parse(deps.tokens[0]!.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('is silent for an address with no verified seat', async () => {
    const deps = makeDeps();
    deps.setVerified(false);
    await deps.service.request('nobody@example.com');
    expect(deps.sent).toHaveLength(0);
    expect(deps.tokens).toHaveLength(0);
  });

  it('mints a session from the verified link and consumes it once', async () => {
    const deps = makeDeps();
    await deps.service.request('owner@example.com');
    const token = extractToken(deps.sent[0]!.text);

    const first = await deps.service.confirm(token);
    expect(first).toEqual({
      token: 'signed.jwt.value',
      tenantId: 'tenant-1',
      email: 'owner@example.com',
      role: 'admin',
    });
    expect(deps.mintSession).toHaveBeenCalledWith({
      sub: 'email:owner@example.com',
      tenantId: 'tenant-1',
      role: 'admin',
      email: 'owner@example.com',
    });

    const second = await deps.service.confirm(token);
    expect(second).toBeUndefined();
    expect(deps.mintSession).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired token without minting a session', async () => {
    const deps = makeDeps();
    await deps.service.request('owner@example.com');
    deps.tokens[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const token = extractToken(deps.sent[0]!.text);

    expect(await deps.service.confirm(token)).toBeUndefined();
    expect(deps.mintSession).not.toHaveBeenCalled();
  });

  it('rejects a garbage token', async () => {
    const deps = makeDeps();
    expect(await deps.service.confirm('short')).toBeUndefined();
    expect(deps.mintSession).not.toHaveBeenCalled();
  });
});
