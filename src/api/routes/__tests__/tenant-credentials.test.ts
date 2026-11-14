// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createTenantCredentialsRouter } from '../tenant-credentials.js';
import type { CredentialVaultService } from '../../../services/credential-vault-service.js';

/**
 * The credential vault is keyed by tenant.
 *
 * The route used to hardcode 'default': in a Cloud deployment every
 * customer shared ONE set of provider credentials, so a customer could read
 * (and overwrite) the registrar credentials of another one. The tenant of
 * the request is the only acceptable key.
 */
function buildApp(tenantId: string): {
  app: Application;
  vault: {
    set: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
} {
  const vault = {
    isConfigured: true,
    set: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.auth = { role: 'admin', tenantId };
    next();
  });
  app.use(
    '/api/v1/tenant/credentials',
    createTenantCredentialsRouter(vault as unknown as CredentialVaultService),
  );
  return { app, vault };
}

describe('the per-tenant credential vault', () => {
  it('stores a credential under the tenant of the request', async () => {
    const { app, vault } = buildApp('tenant-a');

    const res = await request(app)
      .put('/api/v1/tenant/credentials/registrar/porkbun')
      .send({ secret: 'apikey-123' });

    expect(res.status).toBe(200);
    expect(vault.set).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', providerType: 'registrar' }),
    );
  });

  it('lists the credentials of the tenant of the request', async () => {
    const { app, vault } = buildApp('tenant-b');

    await request(app).get('/api/v1/tenant/credentials');

    expect(vault.list).toHaveBeenCalledWith('tenant-b');
  });

  it('deletes a credential of the tenant of the request', async () => {
    const { app, vault } = buildApp('tenant-c');

    await request(app).delete('/api/v1/tenant/credentials/registrar/porkbun');

    expect(vault.clear).toHaveBeenCalledWith('tenant-c', 'registrar', 'porkbun');
  });
});
