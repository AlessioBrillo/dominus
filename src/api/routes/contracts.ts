// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getContractService } from '../../services/contract-service.js';

const acceptanceSchema = z.object({
  email: z.string().email().max(254),
  tenantId: z.string().min(1).max(128).optional(),
  purpose: z.enum(['signup', 'checkout', 'dpa', 'art1341']),
  documentSlug: z.enum(['terms', 'privacy', 'dpa']),
  documentVersion: z.string().min(1).max(64),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be the SHA-256 of the published text'),
  checkoutSessionId: z.string().max(128).optional(),
  billingCode: z.string().max(64).optional(),
});

/**
 * The public, append-only record of contract acceptances.
 *
 * Deliberately unauthenticated: a signup happens before a workspace (and
 * therefore before an API key) exists. The record identifies the person by
 * the email they gave and stores only a hash of the IP and user agent, so it
 * is evidence without becoming a new tracking dataset.
 */
export function createContractsRouter(): Router {
  const router = Router();

  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getContractService();
      if (!service) {
        res.status(503).json({
          error: {
            code: 'CONTRACT_LEDGER_UNAVAILABLE',
            message: 'Contract acceptance recording is not available on this deployment',
          },
        });
        return;
      }
      const parsed = acceptanceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid contract acceptance',
            issues: parsed.error.issues,
          },
        });
        return;
      }
      const body = parsed.data;
      const acceptance = await service.record({
        email: body.email,
        tenantId: body.tenantId ?? null,
        purpose: body.purpose,
        documentSlug: body.documentSlug,
        documentVersion: body.documentVersion,
        contentHash: body.contentHash,
        checkoutSessionId: body.checkoutSessionId ?? null,
        billingCode: body.billingCode ?? null,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json({
        id: acceptance.id,
        purpose: acceptance.purpose,
        documentSlug: acceptance.documentSlug,
        documentVersion: acceptance.documentVersion,
        acceptedAt: acceptance.acceptedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
