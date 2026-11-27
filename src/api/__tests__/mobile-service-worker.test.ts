// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The service worker is a plain script served from the frontend's public/
 * folder, not a module. Evaluating it against a fake `self` keeps the
 * notification tap-through contract testable without a browser (ADR-0116).
 */
type Handler = (event: Record<string, unknown>) => void;

interface LoadedWorker {
  handlers: Map<string, Handler>;
  showNotification: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
}

function loadWorker(): LoadedWorker {
  const handlers = new Map<string, Handler>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const self = {
    addEventListener: (type: string, handler: Handler): Map<string, Handler> =>
      handlers.set(type, handler),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue([{ focus, navigate }]),
      openWindow,
    },
    registration: { showNotification },
    location: { origin: 'https://app.example' },
  };
  const source = readFileSync(resolve(process.cwd(), 'frontend/public/sw.js'), 'utf8');
  new Function('self', 'caches', 'fetch', source)(
    self,
    { open: vi.fn(), keys: vi.fn().mockResolvedValue([]), match: vi.fn() },
    vi.fn(),
  );
  return { handlers, showNotification, navigate, focus, openWindow };
}

async function runHandler(handler: Handler, event: Record<string, unknown>): Promise<void> {
  const waitUntil = vi.fn();
  handler({ ...event, waitUntil });
  const promise = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
  if (promise) await promise;
}

describe('mobile app-shell service worker', () => {
  it('opens the decision route carried by a push payload', async () => {
    const { handlers, showNotification, navigate } = loadWorker();
    await runHandler(handlers.get('push')!, {
      data: { json: () => ({ title: 'Renewal due', url: '/portfolio', domain: 'a.com' }) },
    });

    const notification = showNotification.mock.calls[0]?.[1] as { data: { url: string } };
    expect(notification.data.url).toBe('/portfolio');

    await runHandler(handlers.get('notificationclick')!, {
      notification: { close: vi.fn(), data: notification.data },
    });
    expect(navigate).toHaveBeenCalledWith('/portfolio');
  });

  it('falls back to /alerts for an unsafe push route', async () => {
    const { handlers, showNotification } = loadWorker();
    await runHandler(handlers.get('push')!, {
      data: { json: () => ({ url: 'https://external.example/phishing' }) },
    });
    expect((showNotification.mock.calls[0]?.[1] as { data: { url: string } }).data.url).toBe(
      '/alerts',
    );
  });
});
