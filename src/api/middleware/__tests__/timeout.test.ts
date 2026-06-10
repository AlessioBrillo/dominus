import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requestTimeout } from '../timeout.js';

describe('requestTimeout', () => {
  it('calls res.setTimeout with the configured ms value', () => {
    const setTimeout = vi.fn();
    const req = {} as Request;
    const res = { setTimeout } as unknown as Response;
    const next = vi.fn();

    requestTimeout(500)(req, res, next);

    expect(setTimeout).toHaveBeenCalledWith(500, expect.any(Function));
  });

  it('calls next() immediately', () => {
    const req = {} as Request;
    const res = { setTimeout: vi.fn() } as unknown as Response;
    const next = vi.fn();

    requestTimeout(500)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 408 JSON when the timeout callback fires', () => {
    let timeoutCb: () => void = () => {};
    const setTimeout = vi.fn((_ms: number, cb: () => void) => {
      timeoutCb = cb;
    });
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const req = {} as Request;
    const res = { setTimeout, status, json } as unknown as Response;
    const next = vi.fn();

    requestTimeout(500)(req, res, next);
    timeoutCb();

    expect(status).toHaveBeenCalledWith(408);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out after 500ms' },
    });
  });
});
