// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { CredentialVaultService } from '../../services/credential-vault-service.js';
import type { CredentialProviderType } from '../../types/tenant-credential.js';
import { validate } from '../middleware/validate.js';

const providerTypeParamSchema = z.object({
  providerType: z.enum(['registrar', 'parking', 'adsense', 'gsc', 'marketplace']),
  providerName: z.string().min(1).max(100),
});

const setBodySchema = z.object({
  secret: z.string().min(1).max(10000),
  accountId: z.string().max(200).nullable().optional(),
  credentialScope: z.string().max(200).nullable().optional(),
});

export function createTenantCredentialsRouter(credentialVault: CredentialVaultService): Router {
  const router = Router();

  /** Metadata for all configured credentials of the current tenant. Never returns secrets. */
  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const views = await credentialVault.list('default');
      res.json({ credentials: views });
    } catch (err) {
      next(err);
    }
  });

  /** Store (or replace) a credential for the current tenant. The secret is never returned. */
  router.put(
    '/:providerType/:providerName',
    validate({ params: providerTypeParamSchema, body: setBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { providerType, providerName } = req.params as z.infer<
          typeof providerTypeParamSchema
        >;
        const { secret, accountId, credentialScope } = req.body as z.infer<typeof setBodySchema>;

        if (!credentialVault.isConfigured) {
          res.status(501).json({
            error: {
              code: 'VAULT_NOT_CONFIGURED',
              message:
                'Credential vault is not configured: set VAULT_ENCRYPTION_KEY to store per-tenant credentials',
            },
          });
          return;
        }

        await credentialVault.set({
          tenantId: 'default',
          providerType: providerType as CredentialProviderType,
          providerName,
          secret,
          accountId: accountId ?? null,
          credentialScope: credentialScope ?? null,
        });

        res.json({
          ok: true,
          providerType,
          providerName,
          message: 'Credential stored. It will not be returned in plaintext.',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /** Delete a credential for the current tenant. */
  router.delete(
    '/:providerType/:providerName',
    validate({ params: providerTypeParamSchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { providerType, providerName } = req.params as z.infer<
          typeof providerTypeParamSchema
        >;

        if (!credentialVault.isConfigured) {
          res.status(501).json({
            error: {
              code: 'VAULT_NOT_CONFIGURED',
              message:
                'Credential vault is not configured: set VAULT_ENCRYPTION_KEY to manage per-tenant credentials',
            },
          });
          return;
        }

        const deleted = await credentialVault.clear(
          'default',
          providerType as CredentialProviderType,
          providerName,
        );

        res.json({ ok: true, deleted });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
