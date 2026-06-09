import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveWhoisServer, clearIanaCache } from '../iana-server-lookup.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConnectFn = any;

describe('resolveWhoisServer', () => {
  beforeEach(() => {
    clearIanaCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached server on second call within TTL', async () => {
    const connectFn = vi.fn((_port: number, _host: string, callback?: () => void) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      const socket = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
          return socket;
        }),
        setTimeout: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      process.nextTick(() => callback?.());
      process.nextTick(() => {
        const data = handlers.get('data');
        if (data) for (const h of data) h(Buffer.from('whois: whois.nic.test\n'));
        const end = handlers.get('end');
        if (end) for (const h of end) h();
      });
      return socket;
    });

    const result1 = await resolveWhoisServer('test', connectFn as unknown as ConnectFn);
    expect(result1).toBe('whois.nic.test');
    expect(connectFn).toHaveBeenCalledTimes(1);

    const result2 = await resolveWhoisServer('test', connectFn as unknown as ConnectFn);
    expect(result2).toBe('whois.nic.test');
    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it('returns null and caches failure when IANA query errors', async () => {
    const connectFn = vi.fn((_port: number, _host: string, callback?: () => void) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      const socket = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
          return socket;
        }),
        setTimeout: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      process.nextTick(() => callback?.());
      process.nextTick(() => {
        const error = handlers.get('error');
        if (error) for (const h of error) h(new Error('Connection refused'));
      });
      return socket;
    });

    await expect(
      resolveWhoisServer('error-tld', connectFn as unknown as ConnectFn),
    ).resolves.toBeNull();
  });

  it('wraps non-Error socket rejection into an Error', async () => {
    const connectFn = vi.fn((_port: number, _host: string, callback?: () => void) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      const socket = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
          return socket;
        }),
        setTimeout: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      process.nextTick(() => callback?.());
      process.nextTick(() => {
        const error = handlers.get('error');
        if (error) for (const h of error) h('string error message');
      });
      return socket;
    });

    await expect(
      resolveWhoisServer('string-error', connectFn as unknown as ConnectFn),
    ).resolves.toBeNull();
  });
});
