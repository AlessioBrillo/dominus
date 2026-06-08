import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createWatchlistRouter } from '../watchlist.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { WatchlistService } from '../../../watchlist/watchlist-service.js';
import type { WatchlistEntry, WatchlistPollResult } from '../../../types/watchlist.js';

function makeStubService(): WatchlistService {
  return {
    add: vi.fn().mockImplementation(
      (domain: string, notes?: string) =>
        ({
          id: 1,
          domain,
          tld: '.com',
          notes: notes ?? null,
          lastCheckedAt: null,
          lastStatus: null,
          lastStatusChange: null,
          notified: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }) as WatchlistEntry,
    ),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    poll: vi.fn().mockResolvedValue({
      checked: 0,
      available: 0,
      notified: 0,
      errors: 0,
    } as WatchlistPollResult),
  } as unknown as WatchlistService;
}

function buildApp(service?: WatchlistService): Application {
  const app = express();
  app.use(express.json());
  app.use('/api/watchlist', createWatchlistRouter(service ?? makeStubService()));
  app.use(errorHandler);
  return app;
}

describe('API: /api/watchlist', () => {
  describe('GET /', () => {
    it('returns an empty list', async () => {
      const res = await request(buildApp()).get('/api/watchlist');
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
    });

    it('returns entries', async () => {
      const service = makeStubService();
      (service.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { domain: 'example.com', tld: '.com', notified: 0 },
      ] as unknown as WatchlistEntry[]);
      const res = await request(buildApp(service)).get('/api/watchlist');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0]!.domain).toBe('example.com');
    });
  });

  describe('GET /:domain', () => {
    it('returns entry by domain', async () => {
      const service = makeStubService();
      (service.get as ReturnType<typeof vi.fn>).mockReturnValue({
        domain: 'example.com',
        tld: '.com',
        notified: 0,
      } as WatchlistEntry);
      const res = await request(buildApp(service)).get('/api/watchlist/example.com');
      expect(res.status).toBe(200);
      expect(res.body.entry.domain).toBe('example.com');
    });

    it('returns 404 for missing domain', async () => {
      const res = await request(buildApp()).get('/api/watchlist/missing.com');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /', () => {
    it('creates a new entry', async () => {
      const res = await request(buildApp()).post('/api/watchlist').send({ domain: 'example.com' });
      expect(res.status).toBe(201);
      expect(res.body.entry.domain).toBe('example.com');
    });

    it('accepts optional notes', async () => {
      const res = await request(buildApp())
        .post('/api/watchlist')
        .send({ domain: 'test.io', notes: 'interesting' });
      expect(res.status).toBe(201);
    });

    it('returns 400 for missing domain', async () => {
      const res = await request(buildApp()).post('/api/watchlist').send({});
      expect(res.status).toBe(400);
    });

    it('returns 409 for duplicate domain', async () => {
      const service = makeStubService();
      (service.add as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const err = new Error('UNIQUE constraint failed: watchlist_entries.domain');
        err.name = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      });
      const res = await request(buildApp(service))
        .post('/api/watchlist')
        .send({ domain: 'example.com' });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /:domain', () => {
    it('removes an entry', async () => {
      const res = await request(buildApp()).delete('/api/watchlist/example.com');
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
    });

    it('returns 404 for missing entry', async () => {
      const service = makeStubService();
      (service.remove as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const res = await request(buildApp(service)).delete('/api/watchlist/missing.com');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /poll', () => {
    it('triggers poll and returns result', async () => {
      const service = makeStubService();
      (service.poll as ReturnType<typeof vi.fn>).mockResolvedValue({
        checked: 10,
        available: 2,
        notified: 2,
        errors: 0,
      });
      const res = await request(buildApp(service)).post('/api/watchlist/poll');
      expect(res.status).toBe(200);
      expect(res.body.checked).toBe(10);
      expect(res.body.available).toBe(2);
    });
  });
});
