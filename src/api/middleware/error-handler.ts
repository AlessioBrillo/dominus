import type { Request, Response, NextFunction } from 'express';
import {
  DominusError,
  ProviderError,
  PortfolioError,
  DuplicateDomainError,
} from '../../types/errors.js';
import { getLogger } from '../../logger.js';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

function statusFromError(err: DominusError): number {
  if (err instanceof DuplicateDomainError) return 409;
  if (err instanceof PortfolioError) return 404;
  if (err instanceof ProviderError) return 502;
  return 500;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ErrorResponse>,
  _next: NextFunction,
): void {
  if (err instanceof DominusError) {
    const status = statusFromError(err);
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Log full internal error details server-side, return sanitised message to client
  getLogger().error({ err }, 'Unhandled internal error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
