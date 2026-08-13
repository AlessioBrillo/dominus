// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { UsageMeterService } from '../../services/usage-meter-service.js';
import type { UsageFeature } from '../../types/usage.js';
import { USAGE_FEATURES } from '../../types/usage.js';
import { UsageLimitExceededError } from '../../types/errors.js';

const FEATURES = USAGE_FEATURES;

const featureParam = z.string().refine((v) => (FEATURES as readonly string[]).includes(v), {
  message: `feature must be one of: ${FEATURES.join(', ')}`,
});

const recordSchema = z.object({
  feature: featureParam,
  amount: z.number().int().positive(),
});

const querySchema = z.object({
  feature: featureParam,
});

const historyQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).optional(),
});

export function createUsageRouter(usageService: UsageMeterService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId ?? 'default';
      const periodStart = UsageMeterService.periodStart(new Date().toISOString());
      const usage = await usageService.getUsageForPeriod(
        tenantId,
        parsed.data.feature as UsageFeature,
        periodStart,
      );
      res.json(usage);
    } catch (err) {
      next(err);
    }
  });

  router.get('/limits', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId ?? 'default';
      const limits = await usageService.getAllPlanLimitsForTenant(tenantId);
      res.json(limits);
    } catch (err) {
      next(err);
    }
  });

  router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId ?? 'default';
      const history = await usageService.getUsageHistory(tenantId, parsed.data.months ?? 6);
      res.json(history);
    } catch (err) {
      next(err);
    }
  });

  router.post('/record', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = recordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId ?? 'default';
      const periodStart = UsageMeterService.periodStart(new Date().toISOString());
      const usage = await usageService.record(
        tenantId,
        parsed.data.feature as UsageFeature,
        parsed.data.amount,
        periodStart,
      );
      res.json(usage);
    } catch (err) {
      if (err instanceof UsageLimitExceededError) {
        res.status(429).json({
          error: {
            code: err.code,
            message: err.message,
            context: err.context,
          },
        });
        return;
      }
      next(err);
    }
  });

  return router;
}
