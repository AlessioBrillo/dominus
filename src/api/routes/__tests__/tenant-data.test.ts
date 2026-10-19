// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createTenantDataRouter } from '../tenant-data.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { TenantDataService } from '../../../services/tenant-data-service.js';

function buildApp(role = 'admin', tenantId = 'tenant-1'): Application {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = tenantId;
    req.auth = { role, tenantId, userId: 'user-1' };
    next();
  });

  app.use('/api/v1/tenant', createTenantDataRouter(service));
  app.use(errorHandler);
  return app;
}

let db: SqliteProvider;
let service: TenantDataService;

beforeEach(async () => {
  db = SqliteProvider.openInMemory();
  await db.runMigrations();
  service = new TenantDataService(db);
  await db.exec(
    `INSERT INTO candidates (domain, tld, source, tenant_id) VALUES ('alpha.com', 'com', 'manual', 'tenant-1')`,
  );
});

afterEach(async () => {
  await db.close();
});

describe('API: /api/v1/tenant', () => {
  describe('GET /export', () => {
    it('returns the export of the caller tenant', async () => {
      const res = await request(buildApp()).get('/api/v1/tenant/export');

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('tenant-1');
      expect(res.body.formatVersion).toBe(1);
      const candidates = res.body.tables.find((t: { table: string }) => t.table === 'candidates');
      expect(candidates.rows).toHaveLength(1);
    });

    it('refuses a caller that is not a tenant admin', async () => {
      const res = await request(buildApp('member')).get('/api/v1/tenant/export');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /', () => {
    it('erases the tenant when the confirmation matches', async () => {
      const res = await request(buildApp()).delete('/api/v1/tenant').send({ confirm: 'tenant-1' });

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('tenant-1');
      expect(res.body.liveDataErased).toBe(true);
      expect(res.body.totalRows).toBeGreaterThan(0);
    });

    it('refuses a confirmation that is not the tenant id', async () => {
      const res = await request(buildApp()).delete('/api/v1/tenant').send({ confirm: 'other' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CONFIRMATION_MISMATCH');

      const remaining = await db.query<{ domain: string }>(`SELECT domain FROM candidates`);
      expect(remaining).toHaveLength(1);
    });

    it('refuses a request without a confirmation', async () => {
      const res = await request(buildApp()).delete('/api/v1/tenant').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a caller that is not a tenant admin', async () => {
      const res = await request(buildApp('member')).delete('/api/v1/tenant').send({
        confirm: 'tenant-1',
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});
