import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { WatchlistRepository } from '../../db/repositories/watchlist-repository.js';
import { WatchlistService } from '../watchlist-service.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { Notifier } from '../../notifiers/notifier.js';
import type { Config } from '../../config.js';
import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { WatchlistEntry } from '../../types/watchlist.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_PATH: ':memory:',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    SCORING_CONFIDENCE_THRESHOLD: 0.3,
    SCORING_RECOMMEND_THRESHOLD: 0.4,
    DROP_SCORE_THRESHOLD: 25,
    DROP_RENEWAL_HORIZON_DAYS: 60,
    KEYWORD_DATA_PATH: undefined,
    COMPS_DATA_PATH: undefined,
    USPTO_SEARCH_URL: 'https://tmsearch.uspto.gov/tmsearch',
    EUIPO_CLIENT_ID: undefined,
    EUIPO_CLIENT_SECRET: undefined,
    EUIPO_AUTH_URL: 'https://euipo.europa.eu/oauth2/token',
    EUIPO_API_URL: 'https://euipo.europa.eu/api',
    TM_CACHE_TTL_DAYS: 7,
    SCORING_WEIGHTS_OVERRIDE: undefined,
    DNS_BULK_CONCURRENCY: 10,
    WHOIS_LOOKUP_TIMEOUT: 10_000,
    BUY_MAX_ABSOLUTE_CAP: 500,
    HOST: '127.0.0.1',
    RENEWAL_WARNING_DAYS: 30,
    RENEWAL_CRITICAL_DAYS: 7,
    NOTIFIER_DESKTOP_ENABLED: false,
    NOTIFIER_WEBHOOK_URL: undefined,
    NOTIFIER_TELEGRAM_BOT_TOKEN: undefined,
    NOTIFIER_TELEGRAM_CHAT_ID: undefined,
    SCHEDULER_ENABLED: false,
    SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
    SCHEDULER_RESCORE_CRON: '0 9 * * 1',
    SCHEDULER_PRUNE_CRON: '0 10 1 * *',
    SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
    WATCHLIST_POLL_INTERVAL_HOURS: 6,
    WATCHLIST_RDAP_DELAY_MS: 50,
    CORS_ORIGIN: '*',
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
    RATE_LIMIT_MAX: 100,
    ...overrides,
  };
}

function makeDnsMock(results: Record<string, DomainStatus>): DnsProvider {
  return {
    checkAvailability: vi.fn().mockImplementation((domain: string) => {
      const status = results[domain] ?? DomainStatus.Unknown;
      return Promise.resolve({ domain, status, checkedAt: new Date().toISOString() } as DnsCheckResult);
    }),
    checkBulk: vi.fn(),
  };
}

function makeRdapMock(results: Record<string, RdapResult>): RdapProvider {
  return {
    confirm: vi.fn().mockImplementation((domain: string) => {
      const existing = results[domain];
      if (existing) return Promise.resolve(existing);
      return Promise.resolve({
        domain,
        status: DomainStatus.Registered,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      } as RdapResult);
    }),
  };
}

function makeNotifierMock(): Notifier[] {
  const notifier: Notifier = {
    channel: 'console',
    send: vi.fn().mockResolvedValue(undefined),
  };
  return [notifier];
}

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('WatchlistService', () => {
  let db: Database.Database;
  let repo: WatchlistRepository;
  let config: Config;
  let dnsMock: DnsProvider;
  let rdapMock: RdapProvider;
  let notifiers: Notifier[];
  let service: WatchlistService;

  beforeEach(() => {
    db = openTestDb();
    repo = new WatchlistRepository(db);
    config = makeConfig();
    dnsMock = makeDnsMock({});
    rdapMock = makeRdapMock({});
    notifiers = makeNotifierMock();
    service = new WatchlistService(repo, dnsMock, rdapMock, notifiers, config);
  });

  describe('add', () => {
    it('adds a domain to the watchlist', () => {
      const entry = service.add('example.com');
      expect(entry.domain).toBe('example.com');
      expect(entry.tld).toBe('.com');
      expect(entry.notified).toBe(0);
    });

    it('accepts optional notes', () => {
      const entry = service.add('test.io', 'interesting domain');
      expect(entry.domain).toBe('test.io');
      expect(entry.notes).toBe('interesting domain');
    });

    it('rejects duplicate domain', () => {
      service.add('example.com');
      expect(() => service.add('example.com')).toThrow();
    });
  });

  describe('remove', () => {
    it('removes an existing entry', () => {
      service.add('example.com');
      expect(service.remove('example.com')).toBe(true);
      expect(service.get('example.com')).toBeNull();
    });

    it('returns false for non-existing entry', () => {
      expect(service.remove('nonexistent.com')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all entries', () => {
      service.add('a.com');
      service.add('b.io');
      expect(service.list()).toHaveLength(2);
    });

    it('returns empty array when none', () => {
      expect(service.list()).toHaveLength(0);
    });
  });

  describe('get', () => {
    it('returns entry by domain', () => {
      service.add('example.com');
      const entry = service.get('example.com');
      expect(entry).not.toBeNull();
      expect(entry!.domain).toBe('example.com');
    });

    it('returns null for missing domain', () => {
      expect(service.get('missing.com')).toBeNull();
    });
  });

  describe('poll', () => {
    it('does nothing when watchlist is empty', async () => {
      const result = await service.poll();
      expect(result.checked).toBe(0);
      expect(result.available).toBe(0);
    });

    it('marks registered domains as checked without notifying', async () => {
      service.add('registered.com');
      const dnsMock2 = makeDnsMock({ 'registered.com': DomainStatus.Registered });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(1);
      expect(result.available).toBe(0);
      expect(result.notified).toBe(0);

      const entry = repo.findByDomain('registered.com');
      expect(entry!.lastStatus).toBe(DomainStatus.Registered);
      expect(entry!.lastCheckedAt).not.toBeNull();
    });

    it('notifies when domain becomes available', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(1);
      expect(result.available).toBe(1);
      expect(result.notified).toBe(1);

      const entry = repo.findByDomain('available.com');
      expect(entry!.notified).toBe(1);
      expect(entry!.lastStatus).toBe(DomainStatus.Available);

      expect((notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      const notification = (notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(notification.domain).toBe('available.com');
      expect(notification.alertType).toBe(AlertType.DomainAvailable);
      expect(notification.severity).toBe(AlertSeverity.Success);
    });

    it('does not notify twice for the same availability', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      await svc.poll();
      const result2 = await svc.poll();
      expect(result2.checked).toBe(0);
      expect(result2.available).toBe(0);
    });

    it('dry run does not persist notification', async () => {
      service.add('available.com');
      const dnsMock2 = makeDnsMock({ 'available.com': DomainStatus.Available });
      const rdapMock2 = makeRdapMock({
        'available.com': {
          domain: 'available.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        } as RdapResult,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock2, notifiers, config);

      const result = await svc.poll(true);
      expect(result.available).toBe(1);
      expect(result.notified).toBe(0);

      const entry = repo.findByDomain('available.com');
      expect(entry!.notified).toBe(0);
      expect((notifiers[0]!.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('handles DNS check failure gracefully', async () => {
      service.add('errored.com');
      const dnsMock2: DnsProvider = {
        checkAvailability: vi.fn().mockRejectedValue(new Error('DNS timeout')),
        checkBulk: vi.fn(),
      };
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const result = await svc.poll();
      expect(result.checked).toBe(0);
      expect(result.errors).toBe(1);
    });

    it('processes multiple entries with rate limiting delay', async () => {
      service.add('a.com');
      service.add('b.com');
      service.add('c.com');

      const dnsMock2 = makeDnsMock({
        'a.com': DomainStatus.Registered,
        'b.com': DomainStatus.Registered,
        'c.com': DomainStatus.Registered,
      });
      const svc = new WatchlistService(repo, dnsMock2, rdapMock, notifiers, config);

      const start = Date.now();
      const result = await svc.poll();
      const elapsed = Date.now() - start;

      expect(result.checked).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(100); // 2 delays × 50ms
    });
  });
});
