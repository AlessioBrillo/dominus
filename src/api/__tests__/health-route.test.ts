import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRouter } from '../routes/health.js';

function buildApp(): express.Express {
  const app = express();
  app.use('/api/health', createHealthRouter());
  return app;
}

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('includes uptime, version, and timestamp', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/health');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body).toHaveProperty('version');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('timestamp');
    expect(Date.parse(res.body.timestamp)).not.toBeNaN();
  });
});
