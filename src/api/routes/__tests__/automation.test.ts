// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAutomationRouter } from '../automation.js';
import { errorHandler } from '../../middleware/error-handler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockService(): any {
  return {
    settings: { enabled: true, dryRun: false },
    getSettingsView: vi.fn().mockResolvedValue({
      global: { enabled: true, dryRun: false },
      tenant: { enabled: false, dryRun: true },
      effective: { enabled: false, dryRun: false, refusedBy: 'tenant_switch' },
    }),
    updateTenantSettings: vi.fn().mockResolvedValue({ enabled: true, dryRun: true }),
    run: vi.fn().mockResolvedValue({
      domain: 'example.com',
      source: 'manual',
      enabled: true,
      dryRun: false,
      steps: [{ step: 'listing', status: 'done' }],
    }),
    getStatus: vi.fn().mockResolvedValue([]),
    listSteps: vi.fn().mockResolvedValue([]),
    listAudit: vi.fn().mockResolvedValue([]),
    resetStep: vi.fn().mockResolvedValue(undefined),
    resetAndRun: vi.fn().mockResolvedValue({ domain: 'example.com', source: 'manual', steps: [] }),
  };
}

function makeApp(service: ReturnType<typeof mockService>): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/automation', createAutomationRouter(service));
  app.use(errorHandler);
  return app;
}

describe('Automation API', () => {
  describe('GET /settings', () => {
    it('returns the global, tenant and effective view', async () => {
      const service = mockService();
      const res = await request(makeApp(service)).get('/automation/settings');

      expect(res.status).toBe(200);
      expect(res.body.settings.global).toEqual({ enabled: true, dryRun: false });
      expect(res.body.settings.tenant).toEqual({ enabled: false, dryRun: true });
      expect(res.body.settings.effective).toEqual({
        enabled: false,
        dryRun: false,
        refusedBy: 'tenant_switch',
      });
    });
  });

  describe('PUT /settings', () => {
    it('updates the tenant switch and returns the refreshed view', async () => {
      const service = mockService();
      const res = await request(makeApp(service))
        .put('/automation/settings')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(service.updateTenantSettings).toHaveBeenCalledWith({ enabled: true });
      expect(res.body.settings.global).toEqual({ enabled: true, dryRun: false });
    });

    it('updates dry-run without touching enabled', async () => {
      const service = mockService();
      const res = await request(makeApp(service))
        .put('/automation/settings')
        .send({ dryRun: false });

      expect(res.status).toBe(200);
      expect(service.updateTenantSettings).toHaveBeenCalledWith({ dryRun: false });
    });

    it('rejects an empty body with 400', async () => {
      const service = mockService();
      const res = await request(makeApp(service)).put('/automation/settings').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(service.updateTenantSettings).not.toHaveBeenCalled();
    });

    it('rejects non-boolean fields with 400', async () => {
      const service = mockService();
      const res = await request(makeApp(service))
        .put('/automation/settings')
        .send({ enabled: 'yes' });

      expect(res.status).toBe(400);
      expect(service.updateTenantSettings).not.toHaveBeenCalled();
    });

    it('returns 501 when the deployment has no settings store', async () => {
      const service = mockService();
      service.updateTenantSettings.mockRejectedValue(
        new Error('Tenant automation settings are not available: no settings store is configured'),
      );
      const res = await request(makeApp(service))
        .put('/automation/settings')
        .send({ enabled: true });

      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('AUTOMATION_SETTINGS_UNAVAILABLE');
    });
  });

  describe('POST /run refusal codes', () => {
    it('returns 409 TENANT_AUTOMATION_DISABLED when the tenant is opted out', async () => {
      const service = mockService();
      service.run.mockResolvedValue({
        domain: 'example.com',
        source: 'manual',
        enabled: false,
        dryRun: true,
        steps: [],
        refusedBy: 'tenant_switch',
      });

      const res = await request(makeApp(service))
        .post('/automation/run')
        .send({ domain: 'example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TENANT_AUTOMATION_DISABLED');
    });

    it('returns 409 AUTOMATION_DISABLED when the global kill switch is off', async () => {
      const service = mockService();
      service.run.mockResolvedValue({
        domain: 'example.com',
        source: 'manual',
        enabled: false,
        dryRun: true,
        steps: [],
        refusedBy: 'global_kill_switch',
      });

      const res = await request(makeApp(service))
        .post('/automation/run')
        .send({ domain: 'example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('AUTOMATION_DISABLED');
    });
  });
});
