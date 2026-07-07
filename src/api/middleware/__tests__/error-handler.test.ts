import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from '../error-handler.js';
import {
  DominusError,
  ProviderError,
  PortfolioError,
  DuplicateDomainError,
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
});
