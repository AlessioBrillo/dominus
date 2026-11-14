// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createWorkerRouter } from '../routes/worker.js';
import { createTenantNotificationsRouter } from '../routes/tenant-notifications.js';
import { requireRole } from '../middleware/require-role.js';
import type { JobWorker } from '../../jobs/worker.js';
import type { JobQueueService } from '../../app/job-queue-service.js';
import type { TenantNotificationService } from '../../services/tenant-notification-service.js';

/**
 * The operator surfaces.
 *
 * The queue is shared by every customer and the notification channels are
 * the customer's own: neither is a tenant-wide read. Both are behind the
 * operator role (the queue) or the admin role (the channels).
 */
function buildApp(withGate: boolean): Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The tenant of the caller, as the auth middleware would set it.
    req.tenantId = 'tenant-a';
    req.auth = { role: withGate ? 'operator' : 'admin', tenantId: 'tenant-a' };
    next();
  });

  const worker = {
    getStatus: () => ({ running: true, activeJobs: 0, concurrency: 2 }),
  } as unknown as JobWorker;
  const jobQueueService = {
    getQueueStats: async () => ({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      total: 0,
    }),
    getDeadLetter: async () => [],
  } as unknown as JobQueueService;

  app.use('/api/v1/system', createWorkerRouter(worker, jobQueueService, requireRole('operator')));

  const notificationService = {
    get: async (tenantId: string) => ({
      tenantId,
      email: 'alerts@tenant-a.example',
      hasWebhook: false,
      telegramChatId: null,
      enabled: true,
    }),
    save: async (tenantId: string) => ({
      tenantId,
      email: 'alerts@tenant-a.example',
      hasWebhook: false,
      telegramChatId: null,
      enabled: true,
    }),
    clear: async () => true,
    sendToTenant: async () => ['email'],
  } as unknown as TenantNotificationService;
  app.use('/api/v1/tenant/notifications', createTenantNotificationsRouter(notificationService));

  return app;
}

describe('the operator surfaces', () => {
  it('refuses the queue stats to a caller without the operator role', async () => {
    const app = buildApp(false);
    const res = await request(app).get('/api/v1/system/worker');
    expect(res.status).toBe(403);
  });

  it('answers the queue stats to an operator', async () => {
    const app = buildApp(true);
    const res = await request(app).get('/api/v1/system/worker');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queue');
  });

  it('answers the notification channels of the caller tenant', async () => {
    const app = buildApp(true);
    const res = await request(app).get('/api/v1/tenant/notifications');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('tenant-a');
  });

  it('refuses the notification channels to a member without the admin role', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = 'tenant-a';
      req.auth = { role: 'member', tenantId: 'tenant-a' };
      next();
    });
    const notificationService = {
      get: async () => ({}),
      save: async () => ({}),
      clear: async () => true,
      sendToTenant: async () => [],
    } as unknown as TenantNotificationService;
    app.use('/api/v1/tenant/notifications', createTenantNotificationsRouter(notificationService));

    const res = await request(app).get('/api/v1/tenant/notifications');
    expect(res.status).toBe(403);
  });
});
