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
}

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
 * (USAGE_ENFORCEMENT_ENABLED=false, the default) — it never records, so
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
  const skipPaths = options.skipPaths ?? ['/usage', '/billing', '/system'];

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enabled) {
      next();
      return;
    }

    if (skipPaths.some((p) => req.path.startsWith(p))) {
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
