// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  requestContext,
  resolveRequestId,
  requestStorage,
  getRequestId,
} from '../request-context.js';
import { getLogger, resetLogger } from '../../../logger.js';

function mockReq(inboundId?: unknown): Request {
  return {
    headers: inboundId === undefined ? {} : { 'x-request-id': inboundId },
  } as unknown as Request;
}

function mockRes(): { res: Response; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers.set(key, value);
    }),
    getHeader: (key: string) => headers.get(key),
  } as unknown as Response;
  return { res, headers };
}

describe('requestContext', () => {
  it('sets X-Request-Id on the response', () => {
    const { res, headers } = mockRes();
    const next = vi.fn();

    requestContext()(mockReq(), res, next);

    expect(headers.get('X-Request-Id')).toBeDefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('echoes a client-supplied correlation id', () => {
    const { res, headers } = mockRes();

    requestContext()(mockReq('trace-abc-123'), res, vi.fn());

    expect(headers.get('X-Request-Id')).toBe('trace-abc-123');
  });

  it('replaces an oversized client id instead of trusting it', () => {
    const { res, headers } = mockRes();

    requestContext()(mockReq('x'.repeat(400)), res, vi.fn());

    const issued = headers.get('X-Request-Id');
    expect(issued).toHaveLength(36);
    expect(issued).not.toContain('x');
  });

  it('rejects header-injection attempts, not just overlong values', () => {
    for (const hostile of [
      'trace\r\nX-Injected: yes', // CRLF header injection
      'trace\nX-Injected: yes', // bare LF
      'trace id with spaces', // not a token
      '', // empty
      '<script>alert(1)</script>',
    ]) {
      const { res, headers } = mockRes();
      requestContext()(mockReq(hostile), res, vi.fn());
      expect(headers.get('X-Request-Id')).toMatch(/^[A-Za-z0-9.:_-]{36}$/);
    }
  });

  it('ignores a non-string inbound value', () => {
    const { res, headers } = mockRes();

    requestContext()(mockReq({ evil: true }), res, vi.fn());

    expect(headers.get('X-Request-Id')).toBeDefined();
    expect(headers.get('X-Request-Id')).not.toContain('evil');
  });

  it('makes the id readable from the async context, synchronously', () => {
    const { res } = mockRes();
    let seen: string | undefined;
    let outside: string | undefined;

    requestContext()(mockReq('mid-chain'), res, () => {
      seen = getRequestId();
    });
    outside = getRequestId();

    expect(seen).toBe('mid-chain');
    expect(outside).toBeUndefined();
  });

  it('keeps the context alive across an async boundary', async () => {
    const { res } = mockRes();
    let seen: string | undefined;

    await new Promise<void>((resolve) => {
      requestContext()(mockReq('async-boundary'), res, () => {
        setTimeout(() => {
          seen = getRequestId();
          resolve();
        }, 0);
      });
    });

    expect(seen).toBe('async-boundary');
  });

  it('generates a distinct id per request', () => {
    const { res: r1 } = mockRes();
    const { res: r2 } = mockRes();

    requestContext()(mockReq(), r1, vi.fn());
    requestContext()(mockReq(), r2, vi.fn());

    expect(r1.getHeader('X-Request-Id')).not.toBe(r2.getHeader('X-Request-Id'));
  });
});

describe('resolveRequestId', () => {
  it('issues a UUID-shaped id for absent input', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(resolveRequestId('  padded-id  ')).toBe('padded-id');
  });
});

describe('requestStorage', () => {
  it('is the storage backing getRequestId', () => {
    expect(typeof requestStorage.run).toBe('function');
    let inner: string | undefined;
    requestStorage.run({ requestId: 'direct' }, () => {
      inner = getRequestId();
    });
    expect(inner).toBe('direct');
  });
});

describe('logger mixin', () => {
  it('tags every log line emitted inside a request with the request id', () => {
    // The mixin lives on logger.ts and is what actually carries the id into
    // the 113 existing getLogger() call sites, so it is tested against the
    // real logger rather than a stub.

    // The mixin is never written to stdout in tests: capture the synchronous
    // serialised output by intercepting process.stdout.write for the duration
    // of the two log calls.
    const captured: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: unknown): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };

    resetLogger();
    try {
      requestStorage.run({ requestId: 'corr-77' }, () => {
        getLogger().info({ service: 'test' }, 'inside request');
      });
      getLogger().info({ service: 'test' }, 'outside request');
    } finally {
      process.stdout.write = realWrite;
      resetLogger();
    }

    const parsed = captured
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);

    const inside = parsed.find((l) => l.msg === 'inside request');
    const outside = parsed.find((l) => l.msg === 'outside request');

    expect(inside).toBeDefined();
    expect(inside?.requestId).toBe('corr-77');
    // Outside a request there is no correlation id: the mixin must contribute
    // nothing rather than a null or empty field.
    expect(outside).toBeDefined();
    expect(outside?.requestId).toBeUndefined();
    expect('requestId' in outside!).toBe(false);
  });
});
