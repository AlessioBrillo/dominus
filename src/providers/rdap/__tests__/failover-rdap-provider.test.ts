import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FailoverRdapProvider } from '../failover-rdap-provider.js';
import type { RdapProvider } from '../rdap-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { ProviderError } from '../../../types/errors.js';

function makeProvider(name: string, result: unknown, delayMs = 10): RdapProvider {
  return {
    name,
    confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('FailoverRdapProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result from first provider on success', async () => {
    const primary = makeProvider('primary', {
      domain: 'example.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([primary]);
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Available);
    expect(primary.confirm).toHaveBeenCalledOnce();
  });

  it('falls back to second provider when first fails', async () => {
    const first = makeProvider('rdap.org', new ProviderError('timeout', 'rdap.org'));
    const second = makeProvider('verisign-rdap', {
      domain: 'example.com',
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([first, second], 10);
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).toHaveBeenCalledTimes(1);
  });

  it('skips remaining servers once one succeeds', async () => {
    const first = makeProvider('rdap.org', new ProviderError('timeout', 'rdap.org'));
    const second = makeProvider('verisign-rdap', {
      domain: 'example.com',
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const third = makeProvider('google-rdap', {
      domain: 'example.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([first, second, third], 10);
    await provider.confirm('example.com');
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).toHaveBeenCalledTimes(1);
    expect(third.confirm).not.toHaveBeenCalled();
  });

  it('throws ProviderError when all servers fail', async () => {
    const providers = [
      makeProvider('a', new ProviderError('timeout', 'a')),
      makeProvider('b', new ProviderError('connection refused', 'b')),
    ];

    const provider = new FailoverRdapProvider(providers, 10);
    await expect(provider.confirm('example.com')).rejects.toThrow(ProviderError);
    await expect(provider.confirm('example.com')).rejects.toThrow(
      /All RDAP bootstrap servers failed/,
    );
  });

  it('stops iterating when signal is aborted', async () => {
    const slowProvider: RdapProvider = {
      name: 'slow',
      confirm: vi.fn().mockImplementation(async (_domain: string, signal?: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(resolve, 200);
        });
        return {
          domain: 'example.com',
          status: DomainStatus.Registered,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        };
      }),
    };

    const provider = new FailoverRdapProvider([slowProvider], 10);
    const controller = new AbortController();
    const promise = provider.confirm('example.com', controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('propagates name property correctly', () => {
    const provider = new FailoverRdapProvider([
      makeProvider('first', {}),
      makeProvider('second', {}),
    ]);
    expect(provider.name).toContain('first');
    expect(provider.name).toContain('second');
  });

  it('has delay between failover attempts', async () => {
    vi.useFakeTimers();
    const first = makeProvider('a', new ProviderError('fail', 'a'));
    const second = makeProvider('b', {
      domain: 'example.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });

    const provider = new FailoverRdapProvider([first, second], 100);
    const promise = provider.confirm('example.com');

    await vi.advanceTimersByTimeAsync(50);
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(second.confirm).toHaveBeenCalledTimes(1);

    await expect(promise).resolves.toBeDefined();
    vi.useRealTimers();
  });

  it('builds provider list from URLs via fromConfig', () => {
    const provider = FailoverRdapProvider.fromConfig([
      'https://rdap.org/domain/',
      'https://rdap.verisign.com/com/domain/',
    ]);

    expect(provider.name).toContain('rdap-server-1');
    expect(provider.name).toContain('rdap-server-2');
  });
});
