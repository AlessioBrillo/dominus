import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ExpiryWatcher, ExpiryWindow } from '../expiry-watcher.js';
import type { DomainExpiryInfo } from '../expiry-watcher.js';

function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString();
}

function makeInfo(
  domain: string,
  daysUntilExpiry: number,
  overrides: Partial<DomainExpiryInfo> = {},
): DomainExpiryInfo {
  return {
    domain,
    expiryDate: daysFromNow(daysUntilExpiry),
    tld: '.com',
    ...overrides,
  };
}

describe('ExpiryWatcher', () => {
  let watcher: ExpiryWatcher;

  beforeEach(() => {
    watcher = new ExpiryWatcher({ preReleaseDays: 30, closeoutDays: 7, pollIntervalHours: 6 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getWindow', () => {
    it('returns DropCatch when expiry has passed', () => {
      const window = watcher.getWindow(daysFromNow(-1));
      expect(window).toBe(ExpiryWindow.DropCatch);
    });

    it('returns DropCatch on the exact expiry day', () => {
      const window = watcher.getWindow(daysFromNow(0));
      expect(window).toBe(ExpiryWindow.DropCatch);
    });

    it('returns Closeout when within closeout window', () => {
      const window = watcher.getWindow(daysFromNow(5));
      expect(window).toBe(ExpiryWindow.Closeout);
    });

    it('returns PreRelease when within pre-release but outside closeout', () => {
      const window = watcher.getWindow(daysFromNow(20));
      expect(window).toBe(ExpiryWindow.PreRelease);
    });

    it('returns null when expiry is far in the future', () => {
      const window = watcher.getWindow(daysFromNow(100));
      expect(window).toBeNull();
    });

    it('returns null for invalid expiry date', () => {
      const window = watcher.getWindow('not-a-date');
      expect(window).toBeNull();
    });
  });

  describe('set / remove / size / entries', () => {
    it('tracks added domains', () => {
      watcher.set(makeInfo('example.com', 20));
      expect(watcher.size).toBe(1);
    });

    it('removes a domain from tracking', () => {
      watcher.set(makeInfo('example.com', 20));
      watcher.remove('example.com');
      expect(watcher.size).toBe(0);
    });

    it('returns all tracked entries', () => {
      watcher.set(makeInfo('alpha.com', 20));
      watcher.set(makeInfo('beta.com', 5));
      const entries = watcher.entries();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.domain).sort()).toEqual(['alpha.com', 'beta.com']);
    });

    it('replaces existing entry on set with same domain', () => {
      watcher.set(makeInfo('example.com', 20));
      watcher.set(makeInfo('example.com', 5, { tld: '.io' }));
      expect(watcher.size).toBe(1);
      const entry = watcher.entries()[0]!;
      expect(entry.tld).toBe('.io');
    });
  });

  describe('poll', () => {
    it('returns zero counts when no domains tracked', async () => {
      const result = await watcher.poll();
      expect(result).toEqual({ checked: 0, inWindow: 0, notified: 0, errors: 0 });
    });

    it('fires callback for a domain entering a window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set(makeInfo('example.com', 20));

      const result = await watcher.poll();
      expect(result.checked).toBe(1);
      expect(result.inWindow).toBe(1);
      expect(result.notified).toBe(1);
      expect(callback).toHaveBeenCalledWith(
        'example.com',
        ExpiryWindow.PreRelease,
        expect.any(String),
      );
    });

    it('does not fire callback again for the same window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set(makeInfo('example.com', 20));

      await watcher.poll();
      await watcher.poll();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires callback again when domain enters a different (narrower) window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);

      watcher.set(makeInfo('example.com', 20));
      await watcher.poll();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'example.com',
        ExpiryWindow.PreRelease,
        expect.any(String),
      );

      watcher.set(makeInfo('example.com', 5));
      await watcher.poll();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledWith(
        'example.com',
        ExpiryWindow.Closeout,
        expect.any(String),
      );
    });

    it('handles multiple domains and reports checked/inWindow/notified counts', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set(makeInfo('soon.com', 5));
      watcher.set(makeInfo('far.com', 100));
      watcher.set(makeInfo('past.com', -2));

      const result = await watcher.poll();
      expect(result.checked).toBe(3);
      expect(result.inWindow).toBe(2); // soon + past, far is null
      expect(result.notified).toBe(2);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('continues processing other domains when one callback throws', async () => {
      const callback = vi.fn();
      callback.mockImplementationOnce(() => Promise.reject(new Error('oops')));
      watcher.setOnExpiry(callback);
      watcher.set(makeInfo('broken.com', 5));
      watcher.set(makeInfo('fine.com', 10));

      const result = await watcher.poll();
      expect(result.checked).toBe(2);
      expect(result.inWindow).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.notified).toBe(2); // error + success both counted as notified
    });
  });
});
