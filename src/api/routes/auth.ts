// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import type { TenantProvisioningService } from '../../services/tenant-provisioning-service.js';

export interface LoginRequest {
  apiKey: string;
}

export interface LoginResponse {
  authenticated: boolean;
  token?: string;
  identity?: string;
  error?: string;
}

const registerSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().optional(),
});

export function createAuthRouter(
  authProvider: AuthProvider,
  provisioningService?: TenantProvisioningService,
): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { apiKey } = req.body as LoginRequest;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({
        authenticated: false,
        error: 'API key is required',
      } satisfies LoginResponse);
      return;
    }

    const result = await authProvider.validate(apiKey.trim());

    if (!result.authenticated) {
      res.status(403).json({
        authenticated: false,
        error: 'Invalid API key',
      } satisfies LoginResponse);
      return;
    }

    res.json({
      authenticated: true,
      token: apiKey.trim(),
      identity: result.keyName ?? 'default',
    } satisfies LoginResponse);
  });

  if (provisioningService) {
    router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid registration request',
              issues: parsed.error.issues,
            },
          });
          return;
        }

        const { tenantId, apiKey } = await provisioningService.provisionTenant(parsed.data);
        res.status(201).json({
          tenantId,
          key: apiKey.fullKey,
          prefix: apiKey.prefix,
          message: 'Save this key — it will not be shown again.',
        });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
