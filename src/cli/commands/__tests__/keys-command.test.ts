// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import type { KeyManager } from '../../../providers/auth/auth-provider.js';
import type {
  ApiKeyRepository,
  StoredApiKey,
} from '../../../db/repositories/api-key-repository.js';
import { registerKeysCommand } from '../keys-command.js';

function buildProgram(
  keyManager: KeyManager | undefined,
  apiKeyRepo: ApiKeyRepository | undefined,
): Command {
  const program = new Command();
  registerKeysCommand(program, { keyManager, apiKeyRepo });
  return program;
}

function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return fn().then(() => {
    const out = spy.mock.calls.map((c) => String(c[0])).join('');
    spy.mockRestore();
    return out;
  });
}

describe('keys command', () => {
  it('generates a key for an explicit tenant with the requested role', async () => {
    const keyManager = {
      generate: vi.fn().mockResolvedValue({
        id: 7,
        fullKey: 'deadbeef',
        prefix: 'deadbeef',
        name: 'ops',
      }),
    } as unknown as KeyManager;
    const program = buildProgram(keyManager, undefined as unknown as ApiKeyRepository);

    const out = await captureStdout(() =>
      program.parseAsync([
        'node',
        'dominus',
        'keys',
        'create',
        '--tenant',
        'tenant-1',
        '--role',
        'admin',
      ]),
    );

    expect(keyManager.generate).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      name: 'ops',
      role: 'admin',
    });
    expect(out).toContain('deadbeef');
    expect(out).toContain('Save it now');
  });

  it('lists keys for a tenant without leaking hashes', async () => {
    const key: StoredApiKey = {
      id: 1,
      tenantId: 'tenant-1',
      name: 'ops',
      keyHash: 'salt:derived',
      keyPrefix: 'abcd1234',
      role: 'admin',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const apiKeyRepo = {
      findByTenant: vi.fn().mockResolvedValue([key]),
    } as unknown as ApiKeyRepository;
    const program = buildProgram({ generate: vi.fn() } as unknown as KeyManager, apiKeyRepo);

    const out = await captureStdout(() =>
      program.parseAsync(['node', 'dominus', 'keys', 'list', '--tenant', 'tenant-1']),
    );

    expect(apiKeyRepo.findByTenant).toHaveBeenCalledWith('tenant-1');
    expect(out).toContain('abcd1234');
    expect(out).not.toContain('salt:derived');
  });

  it('registers no commands when key management is unavailable (community edition)', () => {
    const program = buildProgram(undefined, undefined);
    expect(program.commands).toHaveLength(0);
  });
});
