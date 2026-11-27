// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import { WatchlistRepository } from '../../db/repositories/watchlist-repository.js';
import { MobileDeviceRepository } from '../../db/repositories/mobile-device-repository.js';
import { PushSubscriptionRepository } from '../../db/repositories/push-subscription-repository.js';
import { createMobileRouter } from '../routes/mobile.js';
import { errorHandler } from '../middleware/error-handler.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import { DomainStatus } from '../../types/domain-status.js';
import {
  DEVICE_TOKEN_PREFIX,
  DeviceTokenProvider,
} from '../../providers/auth/device-token-provider.js';

async function createApp(vapid = true): Promise<{
  app: express.Express;
  deviceRepo: MobileDeviceRepository;
  pushRepo: PushSubscriptionRepository;
}> {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);

  const portfolioRepo = new PortfolioRepository(provider);
  const alertRepo = new RenewalAlertRepository(provider);
  const watchlistRepo = new WatchlistRepository(provider);
  const deviceRepo = new MobileDeviceRepository(provider);
  const pushRepo = new PushSubscriptionRepository(provider);

  const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  await portfolioRepo.insert({
    domain: 'renewsoon.com',
    tld: 'com',
    acquiredAt: '2025-01-01',
    renewalDate: soon,
    acquisitionCost: 10,
    renewalCost: 15,
    registrar: 'test',
  });
  await alertRepo.upsert(
    {
      domain: 'renewsoon.com',
      portfolioEntryId: 1,
      alertType: AlertType.RenewalImminent,
      severity: AlertSeverity.Warning,
      message: 'Renews in 10 days',
    },
    ['console'],
  );
  await watchlistRepo.insert({ domain: 'watch.me', tld: 'me' });
  await watchlistRepo.updateStatus('watch.me', {
    lastCheckedAt: new Date().toISOString(),
    lastStatus: DomainStatus.Available,
    lastStatusChange: new Date().toISOString(),
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/mobile',
    createMobileRouter({
      deviceRepo,
      pushRepo,
      alertRepo,
      portfolioRepo,
      watchlistRepo,
      marketDataAvailable: false,
      ...(vapid ? { vapidPublicKey: 'test-vapid-public-key' } : {}),
    }),
  );
  app.use(errorHandler);
  return { app, deviceRepo, pushRepo };
}

describe('mobile router', () => {
  it('builds a decision inbox from alerts, renewals and the watchlist', async () => {
    const { app } = await createApp();
    const res = await request(app).get('/api/v1/mobile/today');
    expect(res.status).toBe(200);
    expect(res.body.summary.portfolioDomains).toBe(1);
    expect(res.body.summary.activeAlerts).toBe(1);
    const kinds = res.body.decisions.map((d: { type: string }) => d.type);
    expect(kinds).toContain('alert');
    expect(kinds).toContain('renewal');
    expect(kinds).toContain('watchlist');
    // ADR-0115: the response states the evidence contract.
    expect(res.body.evidence.marketDataAvailable).toBe(false);
    expect(res.body.evidence.note).toContain('not an appraisal');
  });

  it('mints, lists and revokes a device token', async () => {
    const { app } = await createApp();
    const created = await request(app).post('/api/v1/mobile/devices').send({ label: 'Phone' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(new RegExp(`^${DEVICE_TOKEN_PREFIX}`));
    expect(created.body.device.label).toBe('Phone');

    const list = await request(app).get('/api/v1/mobile/devices');
    expect(list.body.devices).toHaveLength(1);

    const revoked = await request(app).delete(`/api/v1/mobile/devices/${created.body.device.id}`);
    expect(revoked.status).toBe(200);

    const after = await request(app).get('/api/v1/mobile/devices');
    expect(after.body.devices[0].revokedAt).toBeTruthy();
  });

  it('validates the minted token through the device auth provider', async () => {
    const { app, deviceRepo } = await createApp();
    const created = await request(app).post('/api/v1/mobile/devices').send({ label: 'Tablet' });
    const provider = new DeviceTokenProvider(deviceRepo);
    const result = await provider.validate(created.body.token);
    expect(result.authenticated).toBe(true);
    expect(result.tenantId).toBe('default');
    expect(result.role).toBe('member');
    expect(await provider.validate('not-a-device-token')).toEqual({ authenticated: false });
    expect(await provider.validate(`${DEVICE_TOKEN_PREFIX}wrong`)).toEqual({
      authenticated: false,
    });
  });

  it('refuses a push subscription without VAPID keys', async () => {
    const { app } = await createApp(false);
    const res = await request(app)
      .put('/api/v1/mobile/push')
      .send({ platform: 'web', endpoint: 'https://push.example.net/s/1', p256dh: 'p', auth: 'a' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PUSH_NOT_CONFIGURED');
  });

  it('requires encryption keys for a web subscription', async () => {
    const { app } = await createApp();
    const res = await request(app)
      .put('/api/v1/mobile/push')
      .send({ platform: 'web', endpoint: 'https://push.example.net/s/1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SUBSCRIPTION');
  });

  it('stores a web subscription and exposes the VAPID public key', async () => {
    const { app } = await createApp();
    const stored = await request(app)
      .put('/api/v1/mobile/push')
      .send({
        platform: 'web',
        endpoint: 'https://push.example.net/s/2',
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
        topics: { renewal: true, watchlist: false, verdict: true },
      });
    expect(stored.status).toBe(200);
    expect(stored.body.subscription.topics.watchlist).toBe(false);

    const current = await request(app).get('/api/v1/mobile/push');
    expect(current.body.enabled).toBe(true);
    expect(current.body.vapidPublicKey).toBe('test-vapid-public-key');
    expect(current.body.subscriptions).toHaveLength(1);
  });
});
