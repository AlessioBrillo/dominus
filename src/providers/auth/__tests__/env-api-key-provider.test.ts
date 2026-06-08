import { describe, it, expect } from 'vitest';
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

    it('skips empty entries in comma-separated list', async () => {
      const provider = new EnvApiKeyProvider('sk-one,,sk-two');
      const oneResult = await provider.validate('sk-one');
      expect(oneResult.authenticated).toBe(true);

      const twoResult = await provider.validate('sk-two');
      expect(twoResult.authenticated).toBe(true);
    });
  });
});
