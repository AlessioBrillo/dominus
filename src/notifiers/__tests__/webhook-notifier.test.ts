import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookNotifier } from '../webhook-notifier.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { Notification } from '../../types/alert.js';

function makeAlert(overrides: Partial<Notification> = {}): Notification {
  return {
    domain: 'example.com',
    alertType: AlertType.RenewalImminent,
    severity: AlertSeverity.Warning,
    message: 'Domain renews in 25 days',
    ...overrides,
  };
}

describe('WebhookNotifier', () => {
  let stderrBuffer: string[];
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    stderrBuffer = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string): boolean => {
      stderrBuffer.push(s);
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderr;
    vi.restoreAllMocks();
  });

  it('sends a POST request with JSON payload on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new WebhookNotifier({ url: 'https://hooks.example.com/alerts' });
    await notifier.send(makeAlert());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.example.com/alerts');

    const callOptions = fetchMock.mock.calls[0]![1] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(callOptions.method).toBe('POST');
    expect(callOptions.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(callOptions.body as string);
    expect(body.event).toBe('notification');
    expect(body.domain).toBe('example.com');
    expect(body.alertType).toBe('renewal_imminent');
    expect(body.severity).toBe('warning');

    expect(stderrBuffer.length).toBe(0);
  });

  it('writes to stderr when webhook returns an error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new WebhookNotifier({ url: 'https://hooks.example.com/alerts' });
    await notifier.send(makeAlert());

    expect(stderrBuffer.join('')).toContain('Webhook returned 500');
    expect(stderrBuffer.join('')).toContain('example.com');
  });

  it('writes to stderr when fetch throws a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new WebhookNotifier({ url: 'https://hooks.example.com/alerts' });
    await notifier.send(makeAlert());

    expect(stderrBuffer.join('')).toContain('Webhook failed for example.com');
    expect(stderrBuffer.join('')).toContain('ECONNREFUSED');
  });
});
