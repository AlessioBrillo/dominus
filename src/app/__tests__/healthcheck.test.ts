import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runHealthcheck } from '../healthcheck.js';

describe('runHealthcheck', () => {
  const originalExit = process.exit;

  beforeEach(() => {
    process.exit = ((code?: number) => {
      const exitCode = code ?? 0;
      const err = new Error(`process.exit(${exitCode})`);
      err.name = 'ExitSignal';
      throw err;
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('exits with 0 on 200', () => {
    const get = ((
      _url: string,
      _opts: unknown,
      cb: (r: { statusCode: number }) => void,
    ): {
      on: () => Record<string, never>;
      destroy: () => Record<string, never>;
    } => {
      expect(() => cb({ statusCode: 200 })).toThrow('process.exit(0)');
      return { on: () => ({}), destroy: () => ({}) };
    }) as never;

    runHealthcheck(get, '3456', '127.0.0.1');
  });

  it('exits with 1 on 503', () => {
    const get = ((
      _url: string,
      _opts: unknown,
      cb: (r: { statusCode: number }) => void,
    ): {
      on: () => Record<string, never>;
      destroy: () => Record<string, never>;
    } => {
      expect(() => cb({ statusCode: 503 })).toThrow('process.exit(1)');
      return { on: () => ({}), destroy: () => ({}) };
    }) as never;

    runHealthcheck(get, '3456', '127.0.0.1');
  });

  it('exits with 1 on request error', () => {
    let onError: () => void = () => {};
    const get = ((
      _url: string,
      _opts: unknown,
      cb: (r: { statusCode: number }) => void,
    ): {
      on: (ev: string, h: () => void) => Record<string, never>;
      destroy: () => Record<string, never>;
    } => {
      try {
        cb({ statusCode: 200 });
      } catch {
        /* process.exit throws, ignore */
      }
      return {
        on: (ev: string, h: () => void): Record<string, never> => {
          if (ev === 'error') onError = h;
          return {};
        },
        destroy: (): Record<string, never> => ({}),
      };
    }) as never;

    runHealthcheck(get, '3456', '127.0.0.1');
    expect(() => onError()).toThrow('process.exit(1)');
  });

  it('exits with 1 on request timeout', () => {
    let onTimeout: () => void = () => {};
    const get = ((
      _url: string,
      _opts: unknown,
      cb: (r: { statusCode: number }) => void,
    ): {
      on: (ev: string, h: () => void) => Record<string, never>;
      destroy: () => Record<string, never>;
    } => {
      try {
        cb({ statusCode: 200 });
      } catch {
        /* process.exit throws, ignore */
      }
      return {
        on: (ev: string, h: () => void): Record<string, never> => {
          if (ev === 'timeout') onTimeout = h;
          return {};
        },
        destroy: (): Record<string, never> => ({}),
      };
    }) as never;

    runHealthcheck(get, '3456', '127.0.0.1');
    expect(() => onTimeout()).toThrow('process.exit(1)');
  });
});
