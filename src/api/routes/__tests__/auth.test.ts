// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createAuthRouter, type SignupVerificationMode } from '../auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { AuthProvider } from '../../../providers/auth/auth-provider.js';
import type { TenantProvisioningService } from '../../../services/tenant-provisioning-service.js';
import type { EmailVerificationService } from '../../../services/email-verification-service.js';

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
    provisionTenant: vi.fn().mockResolvedValue({ tenantId: 'tenant-abc123' }),
    activateOwner: vi.fn().mockResolvedValue({
      id: 1,
      fullKey: 'deadbeef',
      prefix: 'deadbeef',
      name: 'Alessio',
    }),
  } as unknown as TenantProvisioningService;
}

function makeVerificationService(canDeliver: boolean): EmailVerificationService {
  return {
    canDeliver,
    issueSignupVerification: vi.fn().mockResolvedValue({ token: 'tok', link: 'https://x/y' }),
    verifySignup: vi.fn().mockResolvedValue({
      tenantId: 'tenant-abc123',
      key: { id: 1, fullKey: 'deadbeef', prefix: 'deadbeef', name: 'Alessio' },
    }),
    resendSignupVerification: vi.fn().mockResolvedValue(true),
    requestRecovery: vi.fn().mockResolvedValue(true),
    confirmRecovery: vi.fn().mockResolvedValue({
      tenantId: 'tenant-abc123',
      key: { id: 2, fullKey: 'cafebabe', prefix: 'cafebabe', name: 'recovered' },
    }),
  } as unknown as EmailVerificationService;
}

function buildApp(
  provisioning?: TenantProvisioningService,
  verification?: EmailVerificationService,
  mode: SignupVerificationMode = 'required',
): Application {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(makeAuthProvider(), provisioning, verification, mode));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/auth/register', () => {
  it('creates the workspace and asks for the email verification', async () => {
    const provisioning = makeProvisioningService();
    const verification = makeVerificationService(true);
    const app = buildApp(provisioning, verification);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Alessio', email: 'a@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe('tenant-abc123');
    // No key before the address is proven: a key given to whoever typed an
    // address is a key given to whoever typed it first.
    expect(res.body.key).toBeUndefined();
    expect(res.body.verificationRequired).toBe(true);
    expect(provisioning.provisionTenant).toHaveBeenCalledWith({
      name: 'Alessio',
      email: 'a@example.com',
    });
    expect(verification.issueSignupVerification).toHaveBeenCalled();
  });

  it('refuses to create a workspace when the verification email cannot be delivered', async () => {
    const provisioning = makeProvisioningService();
    const app = buildApp(provisioning, makeVerificationService(false));

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Alessio', email: 'a@example.com' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
    // Nothing was written: no orphan workspace.
    expect(provisioning.provisionTenant).not.toHaveBeenCalled();
  });

  it('issues the key right away when the deployment runs without a mail transport', async () => {
    const provisioning = makeProvisioningService();
    const app = buildApp(provisioning, makeVerificationService(false), 'optional');

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Alessio', email: 'a@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe('deadbeef');
    expect(provisioning.activateOwner).toHaveBeenCalled();
  });

  it('requires an email address', async () => {
    const app = buildApp(makeProvisioningService(), makeVerificationService(true));

    const res = await request(app).post('/api/v1/auth/register').send({ name: 'Alessio' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid payloads with 400', async () => {
    const app = buildApp(makeProvisioningService(), makeVerificationService(true));

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

describe('API: /api/v1/auth/verify-email', () => {
  it('activates the workspace and returns the one-time key', async () => {
    const verification = makeVerificationService(true);
    const app = buildApp(makeProvisioningService(), verification);

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'a-verification-token-with-enough-entropy' });

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('deadbeef');
    expect(verification.verifySignup).toHaveBeenCalledWith(
      'a-verification-token-with-enough-entropy',
    );
  });

  it('rejects an invalid token with 400', async () => {
    const verification = makeVerificationService(true);
    vi.mocked(verification.verifySignup).mockRejectedValue(
      new (
        await import('../../../services/email-verification-service.js')
      ).VerificationInvalidError(),
    );
    const app = buildApp(makeProvisioningService(), verification);

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'a-verification-token-with-enough-entropy' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_INVALID');
  });
});

describe('API: /api/v1/auth/recover', () => {
  it('always answers 202, whether the address exists or not', async () => {
    const verification = makeVerificationService(true);
    vi.mocked(verification.requestRecovery).mockResolvedValue(false);
    const app = buildApp(makeProvisioningService(), verification);

    const res = await request(app).post('/api/v1/auth/recover').send({ email: 'a@example.com' });

    expect(res.status).toBe(202);
    expect(res.body.sent).toBe(true);
  });

  it('redeems the recovery token and issues a new key', async () => {
    const verification = makeVerificationService(true);
    const app = buildApp(makeProvisioningService(), verification);

    const res = await request(app)
      .post('/api/v1/auth/recover/confirm')
      .send({ token: 'a-verification-token-with-enough-entropy' });

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('cafebabe');
  });
});
