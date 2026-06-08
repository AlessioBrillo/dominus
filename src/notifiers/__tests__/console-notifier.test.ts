import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConsoleNotifier } from '../console-notifier.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { RenewalAlert } from '../../types/alert.js';

function makeAlert(overrides: Partial<RenewalAlert> = {}): RenewalAlert {
  return {
    id: 1,
    domain: 'example.com',
    portfolioEntryId: 1,
    alertType: AlertType.RenewalImminent,
    severity: AlertSeverity.Warning,
    message: 'Domain renews in 25 days',
    notifiedChannels: ['console'],
    ...overrides,
  };
}

describe('ConsoleNotifier', () => {
  let stdoutBuffer: string[];
  let stderrBuffer: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(() => {
    stdoutBuffer = [];
    stderrBuffer = [];
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string): boolean => { stdoutBuffer.push(s); return true; };
    process.stderr.write = (s: string): boolean => { stderrBuffer.push(s); return true; };
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  it('writes warning alerts to stdout', async () => {
    const notifier = new ConsoleNotifier();
    await notifier.send(makeAlert());
    expect(stdoutBuffer.join('')).toContain('WARNING');
    expect(stdoutBuffer.join('')).toContain('Domain renews in 25 days');
  });

  it('writes critical alerts to stderr', async () => {
    const notifier = new ConsoleNotifier();
    await notifier.send(makeAlert({ severity: AlertSeverity.Critical }));
    expect(stderrBuffer.join('')).toContain('CRITICAL');
  });
});
