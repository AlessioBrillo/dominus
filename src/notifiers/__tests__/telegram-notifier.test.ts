import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramNotifier } from '../telegram-notifier.js';
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

describe('TelegramNotifier', () => {
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

  it('sends a message via Telegram API on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier({ botToken: 'test-token', chatId: 'test-chat' });
    await notifier.send(makeAlert());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = fetchMock.mock.calls[0][0];
    expect(callUrl).toContain('api.telegram.org/bot');
    expect(callUrl).toContain('test-token/sendMessage');

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.chat_id).toBe('test-chat');
    expect(callBody.text).toContain('example.com');
    expect(callBody.parse_mode).toBe('Markdown');

    expect(stderrBuffer.length).toBe(0);
  });

  it('writes to stderr when Telegram API returns an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier({ botToken: 'test-token', chatId: 'test-chat' });
    await notifier.send(makeAlert());

    expect(stderrBuffer.join('')).toContain('Telegram API error: 429');
  });

  it('writes to stderr when fetch throws a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier({ botToken: 'test-token', chatId: 'test-chat' });
    await notifier.send(makeAlert());

    expect(stderrBuffer.join('')).toContain('Telegram notification failed');
    expect(stderrBuffer.join('')).toContain('ECONNRESET');
  });

  it('formats message with alert type and domain name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier({ botToken: 'test-token', chatId: 'test-chat' });
    await notifier.send(makeAlert({ severity: AlertSeverity.Critical }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('DOMINUS Alert');
    expect(body.text).toContain('renewal_imminent');
    expect(body.text).toContain('example.com');
    expect(body.text).toContain('Severity: critical');
    expect(body.disable_web_page_preview).toBe(true);
  });
});
