import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpiryWatcher, ExpiryWindow } from './expiry-watcher.js';

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('ExpiryWatcher', () => {
  let watcher: ExpiryWatcher;

  beforeEach(() => {
    watcher = new ExpiryWatcher({ preReleaseDays: 30, closeoutDays: 7, pollIntervalHours: 6 });
  });

  describe('getWindow', () => {
    it('returns null when expiry is far in the future', () => {
      const result = watcher.getWindow(daysFromNow(365));
      expect(result).toBeNull();
    });

    it('returns PreRelease when expiry is within pre-release window', () => {
      const result = watcher.getWindow(daysFromNow(20));
      expect(result).toBe(ExpiryWindow.PreRelease);
    });

    it('returns Closeout when expiry is within closeout window', () => {
      const result = watcher.getWindow(daysFromNow(3));
      expect(result).toBe(ExpiryWindow.Closeout);
    });

    it('returns DropCatch when expiry has passed', () => {
      const result = watcher.getWindow(daysAgo(1));
      expect(result).toBe(ExpiryWindow.DropCatch);
    });

    it('returns Closeout when expiry is exactly at closeout boundary', () => {
      const result = watcher.getWindow(daysFromNow(7));
      expect(result).toBe(ExpiryWindow.Closeout);
    });

    it('returns PreRelease when expiry is exactly at pre-release boundary', () => {
      const result = watcher.getWindow(daysFromNow(30));
      expect(result).toBe(ExpiryWindow.PreRelease);
    });

    it('returns null when expiry date is invalid', () => {
      const result = watcher.getWindow('not-a-date');
      expect(result).toBeNull();
    });
  });

  describe('poll', () => {
    it('does not fire callback when no domains are in a window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysFromNow(365), tld: '.com' });

      const result = await watcher.poll();
      expect(result.checked).toBe(1);
      expect(result.inWindow).toBe(0);
      expect(result.notified).toBe(0);
      expect(callback).not.toHaveBeenCalled();
    });

    it('fires callback when a domain enters pre-release', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysFromNow(20), tld: '.com' });

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

    it('fires callback only once per window per domain', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysFromNow(20), tld: '.com' });

      await watcher.poll();
      expect(callback).toHaveBeenCalledTimes(1);

      // Second poll should not trigger the callback again
      const result2 = await watcher.poll();
      expect(result2.notified).toBe(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires callback for closeout window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysFromNow(3), tld: '.com' });

      const result = await watcher.poll();
      expect(result.notified).toBe(1);
      expect(callback).toHaveBeenCalledWith(
        'example.com',
        ExpiryWindow.Closeout,
        expect.any(String),
      );
    });

    it('fires callback for drop-catch window', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysAgo(1), tld: '.com' });

      const result = await watcher.poll();
      expect(result.notified).toBe(1);
      expect(callback).toHaveBeenCalledWith(
        'example.com',
        ExpiryWindow.DropCatch,
        expect.any(String),
      );
    });

    it('tracks multiple domains independently', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'far.com', expiryDate: daysFromNow(365), tld: '.com' });
      watcher.set({ domain: 'close.com', expiryDate: daysFromNow(5), tld: '.com' });

      const result = await watcher.poll();
      expect(result.checked).toBe(2);
      expect(result.inWindow).toBe(1);
      expect(result.notified).toBe(1);
    });

    it('returns errors count when date parsing fails', async () => {
      watcher.set({ domain: 'bad-date.com', expiryDate: 'invalid', tld: '.com' });
      const result = await watcher.poll();
      expect(result.checked).toBe(1);
      expect(result.errors).toBe(0); // invalid dates are silently ignored
      expect(result.inWindow).toBe(0);
    });
  });

  describe('remove', () => {
    it('stops tracking a removed domain', async () => {
      const callback = vi.fn();
      watcher.setOnExpiry(callback);
      watcher.set({ domain: 'example.com', expiryDate: daysFromNow(5), tld: '.com' });
      watcher.remove('example.com');

      const result = await watcher.poll();
      expect(result.checked).toBe(0);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('size and entries', () => {
    it('returns correct size', () => {
      expect(watcher.size).toBe(0);
      watcher.set({ domain: 'a.com', expiryDate: daysFromNow(10), tld: '.com' });
      watcher.set({ domain: 'b.com', expiryDate: daysFromNow(20), tld: '.com' });
      expect(watcher.size).toBe(2);
    });

    it('returns all entries', () => {
      watcher.set({ domain: 'a.com', expiryDate: daysFromNow(10), tld: '.com' });
      const entries = watcher.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.domain).toBe('a.com');
    });
  });
});
