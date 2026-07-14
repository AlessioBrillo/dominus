import { Router } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import { DbApiKeyProvider } from '../../providers/auth/db-api-key-provider.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';
import { resolveTenantId } from '../../utils/tenant-context.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface LoginRequest {
  apiKey: string;
}

export interface LoginResponse {
  authenticated: boolean;
  token?: string;
  identity?: string;
  error?: string;
}

export function createAuthRouter(
  authProvider: AuthProvider,
  apiKeyRepo?: ApiKeyRepository,
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

  // API key management endpoints — only available when the auth provider
  // supports key CRUD operations (DbApiKeyProvider in DOMINUS Cloud).
  // The cast is necessary because AuthProvider interface exposes validate()
  // but not generate/list/revoke — those are DbApiKeyProvider-specific.
  if (authProvider.supportsKeyManagement) {
    if (!(authProvider instanceof DbApiKeyProvider)) {
      logger.warn(
        { provider: authProvider.name },
        'Auth provider reports supportsKeyManagement but is not DbApiKeyProvider — key management routes disabled',
      );
    } else {
      const provider = authProvider as DbApiKeyProvider;

      router.post('/api-keys', async (req, res, next) => {
        try {
          const { name, role } = req.body as { name?: string; role?: string };
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } });
            return;
          }
          const generated = await provider.generate({
            tenantId: resolveTenantId(),
            name: name.trim(),
            role: role ?? 'admin',
          });
          res.status(201).json({
            id: generated.id,
            name: generated.name,
            prefix: generated.prefix,
            key: generated.fullKey,
            message: 'Save this key — it will not be shown again.',
          });
        } catch (err) {
          next(err);
        }
      });

      if (apiKeyRepo) {
        router.get('/api-keys', async (_req, res, next) => {
          try {
            const keys = await apiKeyRepo.findByTenant(resolveTenantId());
            res.json(
              keys.map((k) => ({
                id: k.id,
                name: k.name,
                prefix: k.keyPrefix,
                role: k.role,
                expiresAt: k.expiresAt,
                lastUsedAt: k.lastUsedAt,
                createdAt: k.createdAt,
              })),
            );
          } catch (err) {
            next(err);
          }
        });

        router.delete('/api-keys/:id', async (req, res, next) => {
          try {
            const id = parseInt(req.params.id as string, 10);
            if (isNaN(id)) {
              res
                .status(400)
                .json({ error: { code: 'INVALID_ID', message: 'Invalid API key ID' } });
              return;
            }
            await apiKeyRepo.revoke(id);
            res.status(204).send();
          } catch (err) {
            next(err);
          }
        });
      }
    }
  }

  return router;
}
