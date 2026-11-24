// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMagicLinkRouter } from '../magic-link.js';
import type { MagicLinkService } from '../../../services/magic-link-service.js';
import { SESSION_COOKIE } from '../../../providers/auth/session-jwt.js';

function makeApp(
  confirmResult: unknown,
  claims: unknown = undefined,
): { app: express.Express; service: MagicLinkService } {
  const service = {
    enabled: true,
    request: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(confirmResult),
  } as unknown as MagicLinkService;
  const app = express();
  app.use(express.json());
  app.use(
    '/auth/magic-link',
    createMagicLinkRouter({
      service,
      sessionTtlMs: 8 * 3600_000,
      sessionVerifier: { verify: vi.fn().mockResolvedValue(claims) },
    }),
  );
  return { app, service };
}

describe('magic-link routes', () => {
  it('reports whether the flow is available', async () => {
    const { app } = makeApp(undefined);
    const response = await request(app).get('/auth/magic-link/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true });
  });

  it('answers 202 for any email address without revealing seats', async () => {
    const { app, service } = makeApp(undefined);
    const response = await request(app)
      .post('/auth/magic-link/request')
      .send({ email: 'nobody@example.com' });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ sent: true });
    expect(service.request).toHaveBeenCalledWith('nobody@example.com');
  });

  it('swallows delivery errors in the request endpoint', async () => {
    const { app, service } = makeApp(undefined);
    vi.mocked(service.request).mockRejectedValueOnce(new Error('SMTP down'));
    const response = await request(app)
      .post('/auth/magic-link/request')
      .send({ email: 'owner@example.com' });
    expect(response.status).toBe(202);
  });

  it('sets the httpOnly session cookie and returns no API key', async () => {
    const { app } = makeApp({
      token: 'signed.jwt.value',
      tenantId: 'tenant-1',
      email: 'owner@example.com',
      role: 'admin',
    });
    const response = await request(app)
      .post('/auth/magic-link/consume')
      .send({ token: 'a'.repeat(43) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: true,
      tenantId: 'tenant-1',
      email: 'owner@example.com',
      role: 'admin',
    });
    expect(response.body.key).toBeUndefined();
    const cookie = response.headers['set-cookie']?.[0] as string;
    expect(cookie).toContain(`${SESSION_COOKIE}=signed.jwt.value`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('rejects an invalid link', async () => {
    const { app } = makeApp(undefined);
    const response = await request(app)
      .post('/auth/magic-link/consume')
      .send({ token: 'a'.repeat(43) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MAGIC_LINK_INVALID');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('restores a browser session from the cookie', async () => {
    const { app } = makeApp(undefined, {
      sub: 'email:owner@example.com',
      tenantId: 'tenant-1',
      email: 'owner@example.com',
    });
    const response = await request(app)
      .get('/auth/magic-link/me')
      .set('Cookie', `${SESSION_COOKIE}=signed.jwt.value`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: true,
      sub: 'email:owner@example.com',
      tenantId: 'tenant-1',
      email: 'owner@example.com',
    });
  });

  it('returns 401 when there is no browser session', async () => {
    const { app } = makeApp(undefined);
    const response = await request(app).get('/auth/magic-link/me');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token before calling the service', async () => {
    const { app, service } = makeApp(undefined);
    const response = await request(app).post('/auth/magic-link/consume').send({ token: 'x' });
    expect(response.status).toBe(400);
    expect(service.confirm).not.toHaveBeenCalled();
  });
});
