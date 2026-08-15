// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createKeyManagementRouter } from '../api-keys.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { AuthProvider, KeyManager } from '../../../providers/auth/auth-provider.js';
import type { ApiKeyRepository } from '../../../db/repositories/api-key-repository.js';
import type { UsageMeterService } from '../../../services/usage-meter-service.js';
import { runWithTenant } from '../../../utils/tenant-context.js';
import type { SubscriptionPlan } from '../../../types/subscription.js';

function makeAuthProvider(
  generate: (input: { tenantId: string; name: string; role?: string }) => unknown,
): AuthProvider {
  return {
    name: 'DbApiKeyProvider',
    isActive: true,
    supportsKeyManagement: true,
    validate: vi.fn(),
    asKeyManager: () =>
      ({ generate: vi.fn().mockImplementation(generate) }) as unknown as KeyManager,
  } as unknown as AuthProvider;
}

function makeApiKeyRepo(activeCount: number): ApiKeyRepository {
  return {
    countActiveByTenant: vi.fn().mockResolvedValue(activeCount),
    findByTenant: vi.fn().mockResolvedValue([]),
    revoke: vi.fn(),
  } as unknown as ApiKeyRepository;
}

function makeUsageService(plan: SubscriptionPlan): UsageMeterService {
  return {
    effectivePlan: vi.fn().mockResolvedValue(plan),
  } as unknown as UsageMeterService;
}

function buildApp(
  authProvider: AuthProvider,
  apiKeyRepo: ApiKeyRepository,
  usageService: UsageMeterService,
): Application {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'tenant-1';
    req.auth = { role: 'admin', tenantId: 'tenant-1', userId: 'owner-1' };
    runWithTenant(req.tenantId, () => next());
  });

  app.use('/api/v1/keys', createKeyManagementRouter(authProvider, apiKeyRepo, usageService));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/keys', () => {
  it('mints a key when the tenant is below its seat limit', async () => {
    const generate = vi.fn().mockResolvedValue({
      id: 1,
      fullKey: 'deadbeef',
      prefix: 'deadbeef',
      name: 'ops',
    });
    const app = buildApp(makeAuthProvider(generate), makeApiKeyRepo(0), makeUsageService('free'));

    const res = await request(app).post('/api/v1/keys').send({ name: 'ops', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe('deadbeef');
    expect(generate).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      name: 'ops',
      role: 'admin',
    });
  });

  it('rejects minting beyond the plan seat limit with 403', async () => {
    const generate = vi.fn();
    const app = buildApp(makeAuthProvider(generate), makeApiKeyRepo(1), makeUsageService('free'));

    const res = await request(app).post('/api/v1/keys').send({ name: 'second-key' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
    expect(generate).not.toHaveBeenCalled();
  });

  it('allows up to the pro seat limit (3)', async () => {
    const generate = vi.fn().mockResolvedValue({ id: 2, fullKey: 'x', prefix: 'x', name: 'k' });
    const app = buildApp(makeAuthProvider(generate), makeApiKeyRepo(2), makeUsageService('pro'));

    const res = await request(app).post('/api/v1/keys').send({ name: 'k' });

    expect(res.status).toBe(201);
  });

  it('never blocks enterprise tenants', async () => {
    const generate = vi.fn().mockResolvedValue({ id: 3, fullKey: 'x', prefix: 'x', name: 'k' });
    const app = buildApp(
      makeAuthProvider(generate),
      makeApiKeyRepo(50),
      makeUsageService('enterprise'),
    );

    const res = await request(app).post('/api/v1/keys').send({ name: 'k' });

    expect(res.status).toBe(201);
  });

  it('exposes no key routes when key management is unsupported (community)', async () => {
    const provider = {
      name: 'EnvApiKeyProvider',
      isActive: true,
      supportsKeyManagement: false,
      validate: vi.fn(),
      asKeyManager: vi.fn(),
    } as unknown as AuthProvider;
    const app = buildApp(provider, makeApiKeyRepo(99), makeUsageService('free'));

    const res = await request(app).post('/api/v1/keys').send({ name: 'k' });

    expect(res.status).toBe(404);
  });
});
