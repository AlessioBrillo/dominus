// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from '../error-handler.js';
import { requestStorage } from '../request-context.js';
import {
  DominusError,
  ProviderError,
  PortfolioError,
  DuplicateDomainError,
  TenantSuspendedError,
} from '../../../types/errors.js';

describe('errorHandler', () => {
  function mockRes(): Response {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    return { status, json } as unknown as Response;
  }

  function jsonCall(res: Response): unknown {
    const statusMock = res.status as ReturnType<typeof vi.fn>;
    const result = statusMock.mock.results[0] as
      { value: { json: ReturnType<typeof vi.fn> } } | undefined;
    return result?.value.json.mock.calls[0]?.[0];
  }

  it('returns 409 for DuplicateDomainError', () => {
    const err = new DuplicateDomainError('example.com');
    const res = mockRes();
    errorHandler(err, {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonCall(res)).toEqual({
      error: { code: 'DUPLICATE_DOMAIN', message: 'Domain already in portfolio: example.com' },
    });
  });

  it('returns 404 for PortfolioError', () => {
    const res = mockRes();
    errorHandler(
      new PortfolioError('NOT_FOUND', 'Portfolio entry not found'),
      {} as Request,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 502 for ProviderError', () => {
    const res = mockRes();
    errorHandler(new ProviderError('PROVIDER_TIMEOUT', 'RDAP'), {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it('returns 403 for TenantSuspendedError (ADR-0057)', () => {
    const res = mockRes();
    errorHandler(new TenantSuspendedError('tenant-a'), {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(jsonCall(res)).toEqual({
      error: {
        code: 'TENANT_SUSPENDED',
        message: expect.stringContaining('suspended'),
        context: { tenantId: 'tenant-a' },
      },
    });
  });

  it('returns 500 for generic DominusError', () => {
    const res = mockRes();
    errorHandler(new DominusError('msg', 'CODE'), {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('sanitises non-DominusError messages', () => {
    const res = mockRes();
    errorHandler(new Error('sensitive: secret'), {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(jsonCall(res)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('handles string errors', () => {
    const res = mockRes();
    errorHandler('broke', {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('passes typed error code and message to response', () => {
    const res = mockRes();
    errorHandler(
      new DominusError('Too many requests', 'RATE_LIMITED'),
      {} as Request,
      res,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(jsonCall(res)).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  });

  // The existing assertions above use toEqual with exact bodies: adding a
  // `requestId` field would have broken all of them, which is exactly the
  // coupling these new tests make explicit — the field must appear only when
  // a request context exists.
  it('includes requestId in the error body inside a request', () => {
    const res = mockRes();
    requestStorage.run({ requestId: 'err-trace-1' }, () => {
      errorHandler(new DuplicateDomainError('example.com'), {} as Request, res, vi.fn());
    });
    expect(jsonCall(res)).toEqual({
      error: {
        code: 'DUPLICATE_DOMAIN',
        message: 'Domain already in portfolio: example.com',
        requestId: 'err-trace-1',
      },
    });
  });

  it('includes requestId in a sanitised 500 body inside a request', () => {
    const res = mockRes();
    requestStorage.run({ requestId: 'err-trace-2' }, () => {
      errorHandler(new Error('sensitive: secret'), {} as Request, res, vi.fn());
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(jsonCall(res)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: 'err-trace-2',
      },
    });
  });

  it('omits requestId outside a request context', () => {
    const res = mockRes();
    // Outside HTTP (CLI, worker, scheduler) the handler is reached without a
    // request context and must not emit an empty or placeholder id.
    errorHandler(new DuplicateDomainError('example.com'), {} as Request, res, vi.fn());
    expect(jsonCall(res)).toEqual({
      error: { code: 'DUPLICATE_DOMAIN', message: 'Domain already in portfolio: example.com' },
    });
  });
});
