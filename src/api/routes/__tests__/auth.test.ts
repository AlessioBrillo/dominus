// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createAuthRouter } from '../auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { AuthProvider } from '../../../providers/auth/auth-provider.js';
import type { TenantProvisioningService } from '../../../services/tenant-provisioning-service.js';

function makeAuthProvider(): AuthProvider {
  return {
    name: 'DbApiKeyProvider',
    isActive: true,
    supportsKeyManagement: true,
    validate: vi.fn().mockResolvedValue({ authenticated: false }),
    asKeyManager: vi.fn(),
  } as unknown as AuthProvider;
}

function makeProvisioningService(): TenantProvisioningService {
  return {
    provisionTenant: vi.fn().mockResolvedValue({
      tenantId: 'tenant-abc123',
      apiKey: { id: 1, fullKey: 'deadbeef', prefix: 'deadbeef', name: 'Alessio' },
    }),
  } as unknown as TenantProvisioningService;
}

function buildApp(provisioning?: TenantProvisioningService): Application {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(makeAuthProvider(), provisioning));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/auth/register', () => {
  it('registers a tenant and returns the one-time key', async () => {
    const provisioning = makeProvisioningService();
    const app = buildApp(provisioning);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Alessio', email: 'a@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe('tenant-abc123');
    expect(res.body.key).toBe('deadbeef');
    expect(provisioning.provisionTenant).toHaveBeenCalledWith({
      name: 'Alessio',
      email: 'a@example.com',
    });
  });

  it('rejects invalid payloads with 400', async () => {
    const app = buildApp(makeProvisioningService());

    const res = await request(app).post('/api/v1/auth/register').send({ name: '', email: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is not mounted in the community edition (no provisioning service)', async () => {
    const app = buildApp(undefined);

    const res = await request(app).post('/api/v1/auth/register').send({ name: 'Alessio' });

    expect(res.status).toBe(404);
  });
});
