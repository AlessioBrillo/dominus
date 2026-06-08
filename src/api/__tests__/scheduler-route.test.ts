import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchedulerRouter } from '../routes/scheduler.js';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';

function buildApp(scheduler: SchedulerService): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduler', createSchedulerRouter(scheduler));
  return app;
}

function mockScheduler(overrides?: Partial<SchedulerService>): SchedulerService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    runOnce: vi.fn().mockResolvedValue('OK'),
    getStatus: vi.fn().mockReturnValue([
      {
        name: 'renewal-check',
        cronExpression: '0 6 * * *',
        description: 'Check portfolio renewal dates',
        lastRunAt: null,
        lastResult: null,
      },
    ]),
    ...overrides,
  } as unknown as SchedulerService;
}

describe('GET /api/scheduler', () => {
  it('returns 200 with scheduler job status', async () => {
    const scheduler = mockScheduler();
    const app = buildApp(scheduler);
    const res = await request(app).get('/api/scheduler');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobs');
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]).toHaveProperty('name', 'renewal-check');
  });

  it('forwards errors from scheduler.getStatus', async () => {
    const scheduler = mockScheduler({
      getStatus: vi.fn().mockImplementation(() => {
        throw new Error('DB unavailable');
      }),
    });
    const app = buildApp(scheduler);
    const res = await request(app).get('/api/scheduler');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/scheduler/run/:job', () => {
  it('runs a known job and returns 200 with result', async () => {
    const scheduler = mockScheduler();
    const app = buildApp(scheduler);
    const res = await request(app).post('/api/scheduler/run/renewal-check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: 'renewal-check', result: 'OK' });
  });

  it('returns 404 when job name segment is missing', async () => {
    const scheduler = mockScheduler();
    const app = buildApp(scheduler);
    const res = await request(app).post('/api/scheduler/run/');
    // Express does not match :job param to an empty segment
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown job', async () => {
    const scheduler = mockScheduler({
      runOnce: vi.fn().mockRejectedValue(new Error('Unknown job: bogus')),
    });
    const app = buildApp(scheduler);
    const res = await request(app).post('/api/scheduler/run/bogus');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_JOB');
  });

  it('forwards unexpected errors from route handler', async () => {
    const scheduler = mockScheduler({
      runOnce: vi.fn().mockRejectedValue(new Error('Unexpected error')),
    });
    const app = buildApp(scheduler);
    const res = await request(app).post('/api/scheduler/run/test');
    expect(res.status).toBe(404);
  });
});
