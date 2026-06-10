import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvApiKeyProvider } from '../env-api-key-provider.js';

describe('EnvApiKeyProvider', () => {
  describe('isActive', () => {
    it('is false when env is undefined', () => {
      const provider = new EnvApiKeyProvider(undefined);
      expect(provider.isActive).toBe(false);
    });

    it('is false when env is empty string', () => {
      const provider = new EnvApiKeyProvider('');
      expect(provider.isActive).toBe(false);
    });

    it('is false when env is whitespace only', () => {
      const provider = new EnvApiKeyProvider('   ');
      expect(provider.isActive).toBe(false);
    });

    it('is true when env has a key', () => {
      const provider = new EnvApiKeyProvider('sk-test123');
      expect(provider.isActive).toBe(true);
    });
  });

  describe('validate', () => {
    it('returns authenticated:false when inactive', async () => {
      const provider = new EnvApiKeyProvider(undefined);
      const result = await provider.validate('anything');
      expect(result.authenticated).toBe(false);
    });

    it('accepts a bare API key', async () => {
      const provider = new EnvApiKeyProvider('sk-test123');
      const result = await provider.validate('sk-test123');
      expect(result.authenticated).toBe(true);
      expect(result.keyName).toBe('default');
    });

    it('rejects an invalid bare API key', async () => {
      const provider = new EnvApiKeyProvider('sk-test123');
      const result = await provider.validate('wrong-key');
      expect(result.authenticated).toBe(false);
    });

    it('accepts a named API key', async () => {
      const provider = new EnvApiKeyProvider('admin=sk-admin-key');
      const result = await provider.validate('sk-admin-key');
      expect(result.authenticated).toBe(true);
      expect(result.keyName).toBe('admin');
    });

    it('handles multiple keys separated by comma', async () => {
      const provider = new EnvApiKeyProvider('admin=sk-admin,readonly=sk-readonly');
      const adminResult = await provider.validate('sk-admin');
      expect(adminResult.authenticated).toBe(true);
      expect(adminResult.keyName).toBe('admin');

      const roResult = await provider.validate('sk-readonly');
      expect(roResult.authenticated).toBe(true);
      expect(roResult.keyName).toBe('readonly');
    });

    it('rejects keys not in the list', async () => {
      const provider = new EnvApiKeyProvider('admin=sk-admin');
      const result = await provider.validate('some-unknown-key');
      expect(result.authenticated).toBe(false);
    });

    it('handles mixed named and unnamed keys', async () => {
      const provider = new EnvApiKeyProvider('sk-default,admin=sk-admin');
      const defaultResult = await provider.validate('sk-default');
      expect(defaultResult.authenticated).toBe(true);
      expect(defaultResult.keyName).toBe('default');

      const adminResult = await provider.validate('sk-admin');
      expect(adminResult.authenticated).toBe(true);
      expect(adminResult.keyName).toBe('admin');
    });

    it('prefers FILE_API_KEYS over API_KEYS env var', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
      const filePath = join(dir, 'api-keys.conf');
      writeFileSync(filePath, 'file-key=sk-from-file\n');
      try {
        const provider = new EnvApiKeyProvider('env=sk-from-env', filePath);
        expect(provider.isActive).toBe(true);
        const envResult = await provider.validate('sk-from-env');
        expect(envResult.authenticated).toBe(false);
        const fileResult = await provider.validate('sk-from-file');
        expect(fileResult.authenticated).toBe(true);
        expect(fileResult.keyName).toBe('file-key');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads named and unnamed keys from file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
      const filePath = join(dir, 'api-keys.conf');
      writeFileSync(filePath, 'admin=sk-admin\nro=sk-readonly\nsk-default\n');
      try {
        const provider = new EnvApiKeyProvider(undefined, filePath);
        expect(provider.isActive).toBe(true);

        let result = await provider.validate('sk-admin');
        expect(result.authenticated).toBe(true);
        expect(result.keyName).toBe('admin');

        result = await provider.validate('sk-readonly');
        expect(result.authenticated).toBe(true);
        expect(result.keyName).toBe('ro');

        result = await provider.validate('sk-default');
        expect(result.authenticated).toBe(true);
        expect(result.keyName).toBe('default');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('ignores comments and blank lines in file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
      const filePath = join(dir, 'api-keys.conf');
      writeFileSync(filePath, '# this is a comment\n\nadmin=sk-admin\n  \nro=sk-ro\n');
      try {
        const provider = new EnvApiKeyProvider(undefined, filePath);
        expect(provider.isActive).toBe(true);

        let result = await provider.validate('sk-admin');
        expect(result.authenticated).toBe(true);

        result = await provider.validate('sk-ro');
        expect(result.authenticated).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to env when file is missing', async () => {
      const provider = new EnvApiKeyProvider('env=sk-env', '/nonexistent/path/keys.conf');
      expect(provider.isActive).toBe(true);
      const result = await provider.validate('sk-env');
      expect(result.authenticated).toBe(true);
      expect(result.keyName).toBe('env');
    });

    it('handles read error gracefully (file is a directory)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
      try {
        const provider = new EnvApiKeyProvider(undefined, dir);
        expect(provider.isActive).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to env when file is empty', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dominus-test-'));
      const filePath = join(dir, 'empty-keys.conf');
      writeFileSync(filePath, '');
      try {
        const provider = new EnvApiKeyProvider('env=sk-env', filePath);
        expect(provider.isActive).toBe(true);
        const result = await provider.validate('sk-env');
        expect(result.authenticated).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('skips empty entries in comma-separated list', async () => {
      const provider = new EnvApiKeyProvider('sk-one,,sk-two');
      const oneResult = await provider.validate('sk-one');
      expect(oneResult.authenticated).toBe(true);

      const twoResult = await provider.validate('sk-two');
      expect(twoResult.authenticated).toBe(true);
    });
  });
});
