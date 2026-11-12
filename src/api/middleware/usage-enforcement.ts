// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction } from 'express';
import { UsageMeterService } from '../../services/usage-meter-service.js';
import type { UsageFeature } from '../../types/usage.js';
import { UsageLimitExceededError } from '../../types/errors.js';

export interface UsageEnforcementOptions {
  /** Feature metered per request (default: 'api_calls'). */
  feature?: UsageFeature;
  /** Period bucket; defaults to the current UTC month. */
  periodStart?: () => string;
  /** Skip enforcement (and recording) for these path prefixes. */
  skipPaths?: string[];
  /**
   * Meter the read-only requests too (default: false).
   *
   * The dashboard reads: every page load is a handful of GETs, and the
   * query cache polls. Metering the reads burned the tenant's monthly
   * `api_calls` allowance in a few hours of ordinary use, and wrote a
   * counter row for every page view. The plan is gated by the limits that
   * describe the work the platform does (`candidates_scored`,
   * `domains_tracked`), and the platform itself is protected by the
   * per-IP rate limit.
   */
  meterReads?: boolean;
}

/**
 * The HTTP methods that change something. They are the ones that cost the
 * platform work worth metering.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Pre-flight usage enforcement for the protected API.
 *
 * Each request atomically records one unit of the metered feature against
 * the tenant's plan limit (see UsageRepository.incrementUsageIfWithinLimit).
 * When the plan limit is exhausted the request is rejected with HTTP 429
 * BEFORE any work starts, instead of allowing the work and failing later.
 * Metered requests and explicit POST /api/v1/usage/record calls share the
 * same atomic counter, so they can never double-count.
 *
 * The middleware is a pass-through when the enforcement feature is disabled
 * (USAGE_ENFORCEMENT_ENABLED=false, the default) - it never records, so
 * existing deployments observe zero behavior change.
 */
export function createUsageEnforcementMiddleware(
  usageService: UsageMeterService,
  enabled: boolean,
  options: UsageEnforcementOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const feature: UsageFeature = options.feature ?? 'api_calls';
  const defaultPeriodStart = (): string => UsageMeterService.periodStart(new Date().toISOString());
  const periodStart: () => string = options.periodStart ?? defaultPeriodStart;
  // Admin/self-serve control-plane routes are never metered.
  const skipPaths = options.skipPaths ?? ['/usage', '/billing', '/system', '/keys'];
  const meterReads = options.meterReads ?? false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enabled) {
      next();
      return;
    }

    if (skipPaths.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }

    if (!meterReads && !WRITE_METHODS.has(req.method)) {
      next();
      return;
    }

    const tenantId = req.tenantId ?? 'default';
    try {
      await usageService.record(tenantId, feature, 1, periodStart());
      next();
    } catch (err) {
      if (err instanceof UsageLimitExceededError) {
        res.status(429).json({
          error: {
            code: err.code,
            message: err.message,
            context: err.context,
          },
          usage: {
            feature: err.feature,
            current: err.current,
            requested: err.requested,
            limitValue: err.limitValue,
          },
        });
        return;
      }
      next(err);
    }
  };
}
