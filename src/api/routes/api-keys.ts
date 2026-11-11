// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { AuthProvider, KeyManager } from '../../providers/auth/auth-provider.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';
import type { UsageMeterService } from '../../services/usage-meter-service.js';
import { TEAM_PLAN_LIMITS } from '../../types/team.js';
import { resolveTenantId } from '../../utils/tenant-context.js';
import { requireRole } from '../middleware/require-role.js';
import { SeatLimitExceededError } from '../../types/errors.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

function resolveKeyManager(authProvider: AuthProvider): KeyManager | undefined {
  return authProvider.asKeyManager() as KeyManager | undefined;
}

/**
 * API key self-service management, scoped to the caller's tenant.
 *
 * Must be mounted BEHIND createAuthMiddleware (i.e. inside the protected
 * router): requireRole needs req.auth and generate()/findByTenant() rely on
 * the tenant AsyncLocalStorage context. Previously these routes lived in the
 * public auth router, so req.auth was never populated and every call failed
 * with a dead 403 — key rotation/revocation was impossible in production.
 */
export function createKeyManagementRouter(
  authProvider: AuthProvider,
  apiKeyRepo?: ApiKeyRepository,
  usageService?: UsageMeterService,
): Router {
  const router = Router();

  // Only expose the surface when the auth provider supports key CRUD
  // (DbApiKeyProvider, directly or wrapped in a CompositeAuthProvider for
  // AUTH_PROVIDER=auth0). Gated to the admin role — any authenticated caller
  // could otherwise mint admin keys (ADR-0032).
  if (!authProvider.supportsKeyManagement) {
    return router;
  }

  const provider = resolveKeyManager(authProvider);
  if (!provider) {
    logger.warn(
      { provider: authProvider.name },
      'Auth provider reports supportsKeyManagement but no DbApiKeyProvider could be resolved — key management routes disabled',
    );
    return router;
  }

  // Machine-credential quota (ADR-0038): the number of active API keys a
  // tenant may hold. The quota is separate from the seat quota: a key is
  // not a person, and a tenant whose three seats are taken by three
  // humans still needs a key for its CI.
  async function assertKeyQuotaAvailable(): Promise<void> {
    if (!apiKeyRepo || !usageService) {
      return;
    }
    const tenantId = resolveTenantId();
    const plan = await usageService.effectivePlan(tenantId);
    const limit = TEAM_PLAN_LIMITS[plan].apiKeys;
    const activeKeys = await apiKeyRepo.countActiveByTenant(tenantId);
    if (activeKeys >= limit) {
      throw new SeatLimitExceededError(plan, limit);
    }
  }

  router.post('/', requireRole('admin'), async (req, res, next) => {
    try {
      const { name, role } = req.body as { name?: string; role?: string };
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } });
        return;
      }
      if (role !== undefined && role !== 'admin' && role !== 'member') {
        res
          .status(400)
          .json({ error: { code: 'INVALID_INPUT', message: "role must be 'admin' or 'member'" } });
        return;
      }
      await assertKeyQuotaAvailable();
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
    router.get('/', requireRole('admin'), async (_req, res, next) => {
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

    router.delete('/:id', requireRole('admin'), async (req, res, next) => {
      try {
        const id = parseInt(req.params.id as string, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid API key ID' } });
          return;
        }
        await apiKeyRepo.revoke(id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
