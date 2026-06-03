import { describe, it, expect } from 'vitest';
import { UsptoCasesProvider } from '../uspto-provider.js';
import { EuipoProvider } from '../euipo-provider.js';
import { ProviderNotImplementedError } from '../../../types/errors.js';

describe('UsptoCasesProvider', () => {
  it('throws ProviderNotImplementedError (stub pending HTTP implementation)', async () => {
    const provider = new UsptoCasesProvider();
    await expect(provider.search('nike')).rejects.toBeInstanceOf(
      ProviderNotImplementedError,
    );
  });
});

describe('EuipoProvider', () => {
  it('throws ProviderNotImplementedError (stub pending HTTP implementation)', async () => {
    const provider = new EuipoProvider();
    await expect(provider.search('apple')).rejects.toBeInstanceOf(
      ProviderNotImplementedError,
    );
  });
});
