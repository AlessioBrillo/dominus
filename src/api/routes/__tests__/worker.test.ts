import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWorkerRouter } from '../worker.js';
import type { JobWorker } from '../../../jobs/worker.js';
import type { JobQueueService } from '../../../app/job-queue-service.js';
import { errorHandler } from '../../middleware/error-handler.js';

function makeStubWorker(overrides?: Partial<ReturnType<JobWorker['getStatus']>>): JobWorker {
  return {
    getStatus: () => ({ running: true, activeJobs: 1, concurrency: 2, ...overrides }),
  } as unknown as JobWorker;
}

function makeStubQueueService(overrides?: Partial<JobQueueService>): JobQueueService {
  return {
    getQueueStats: vi.fn().mockResolvedValue({
      queued: 3,
      running: 1,
      completed: 10,
      failed: 2,
      deadLetter: 1,
      total: 17,
    }),
    getDeadLetter: vi.fn().mockResolvedValue([
      {
        id: 1,
        originalJobId: 42,
        jobType: 'BACKUP',
        payloadJson: '{}',
        error: 'disk full',
        attempts: 3,
        failedAt: new Date().toISOString(),
        originalCreatedAt: new Date().toISOString(),
      },
    ]),
    ...overrides,
  } as unknown as JobQueueService;
}

describe('Worker Router — GET /system/worker', () => {
  it('returns worker status, queue stats, and dead-letter entries', async () => {
    const app = express();
    app.use('/system', createWorkerRouter(makeStubWorker(), makeStubQueueService()));
    app.use(errorHandler);

    const res = await request(app).get('/system/worker');

    expect(res.status).toBe(200);
    expect(res.body.worker).toEqual({ running: true, activeJobs: 1, concurrency: 2 });
    expect(res.body.queue).toEqual({
      queued: 3,
      running: 1,
      completed: 10,
      failed: 2,
      deadLetter: 1,
      total: 17,
    });
    expect(res.body.deadLetterRecent).toHaveLength(1);
    expect(res.body.deadLetterRecent[0]).toMatchObject({
      id: 1,
      jobType: 'BACKUP',
      error: 'disk full',
      attempts: 3,
    });
  });

  it('returns defaults when worker is undefined', async () => {
    const app = express();
    app.use('/system', createWorkerRouter(undefined, makeStubQueueService()));
    app.use(errorHandler);

    const res = await request(app).get('/system/worker');

    expect(res.status).toBe(200);
    expect(res.body.worker).toEqual({ running: false, activeJobs: 0, concurrency: 0 });
  });

  it('forwards errors to next() when queue service throws', async () => {
    const app = express();
    app.use(
      '/system',
      createWorkerRouter(
        makeStubWorker(),
        makeStubQueueService({
          getQueueStats: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      ),
    );
    app.use(errorHandler);

    const res = await request(app).get('/system/worker');

    expect(res.status).toBe(500);
  });
});
