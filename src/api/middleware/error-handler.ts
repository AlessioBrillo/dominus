// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction } from 'express';
import {
  DominusError,
  ProviderError,
  PortfolioError,
  DuplicateDomainError,
  UsageLimitExceededError,
  TenantSuspendedError,
} from '../../types/errors.js';
import { getLogger } from '../../logger.js';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
  };
  usage?: {
    feature: string;
    current: number;
    requested: number;
    limitValue: number | null;
  };
}

function statusFromError(err: DominusError): number {
  if (err instanceof DuplicateDomainError) return 409;
  if (err instanceof PortfolioError) return 404;
  if (err instanceof ProviderError) return 502;
  if (err instanceof UsageLimitExceededError) return 429;
  if (err instanceof TenantSuspendedError) return 403;
  return 500;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ErrorResponse>,
  _next: NextFunction,
): void {
  // Usage limits surface a structured 429 with allowance details so clients
  // can render "you've hit your monthly allowance" UIs (ADR-0038).
  if (err instanceof UsageLimitExceededError) {
    res.status(429).json({
      error: { code: err.code, message: err.message, context: err.context },
      usage: {
        feature: err.feature,
        current: err.current,
        requested: err.requested,
        limitValue: err.limitValue,
      },
    });
    return;
  }

  if (err instanceof DominusError) {
    const status = statusFromError(err);
    const hasContext = Object.keys(err.context).length > 0;
    res.status(status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(hasContext ? { context: err.context } : {}),
      },
    });
    return;
  }

  // Log full internal error details server-side, return sanitised message to client
  getLogger().error({ err }, 'Unhandled internal error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
