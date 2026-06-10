import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBuyCommand } from '../commands/buy-command.js';
import { PurchaseNotApprovedError } from '../../types/registrar.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockPurchaseService(): any {
  return {
    registrarName: 'test-registrar',
    preflight: vi.fn(),
    execute: vi.fn(),
    checkPrice: vi.fn(),
  };
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let buffer = '';
  let errBuffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    errBuffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = originalWrite;
      process.stderr.write = originalStderr;
    })
    .then((): string => buffer + (errBuffer ? '\nSTDERR:\n' + errBuffer : ''));
}

describe('CLI: dominus buy check', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints domain availability', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: 500,
      confidence: 0.7,
      suggestedBuyMax: 250,
      trademarkClear: true,
      operatorApprovalRequired: false,
    });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'check', 'example.com']);
    });

    expect(out).toContain('AVAILABLE');
    expect(out).toContain('€10.00');
  });

  it('prints JSON output with --json', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: 500,
      confidence: 0.7,
      suggestedBuyMax: 250,
      trademarkClear: true,
      operatorApprovalRequired: false,
    });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'check', 'example.com', '--json']);
    });

    const parsed = JSON.parse(out);
    expect(parsed.available).toBe(true);
    expect(parsed.registerPriceEur).toBe(10);
  });

  it('prints error on exception', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockRejectedValue(new Error('API unavailable'));

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'check', 'example.com']);
    });

    expect(out).toContain('ERROR');
    expect(out).toContain('API unavailable');
  });
});

describe('CLI: dominus buy execute', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows unavailable and exits', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: false,
      registerPriceEur: null,
      renewalPriceEur: null,
      expectedValue: null,
      confidence: null,
      suggestedBuyMax: null,
      trademarkClear: false,
      operatorApprovalRequired: true,
    });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'execute', 'example.com']);
    });

    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });

  it('warns on TM block and exits without --yes', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: null,
      confidence: null,
      suggestedBuyMax: null,
      trademarkClear: false,
      operatorApprovalRequired: true,
    });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'execute', 'example.com']);
    });

    expect(out).toContain('WARNING');
    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });

  it('shows dry run message', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: 500,
      confidence: 0.7,
      suggestedBuyMax: 250,
      trademarkClear: true,
      operatorApprovalRequired: false,
    });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'buy',
        'execute',
        'example.com',
        '--dry-run',
        '--yes',
      ]);
    });

    expect(out).toContain('DRY RUN');
  });

  it('executes purchase successfully with --yes', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: null,
      confidence: null,
      suggestedBuyMax: null,
      trademarkClear: true,
      operatorApprovalRequired: true,
    });
    svc.execute.mockResolvedValue({ success: true, message: 'Purchase successful' });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'execute', 'example.com', '--yes']);
    });

    expect(out).toContain('Purchase successful');
    expect(svc.execute).toHaveBeenCalledWith('example.com', 1, true);
  });

  it('prints failure on execute error', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: null,
      confidence: null,
      suggestedBuyMax: null,
      trademarkClear: true,
      operatorApprovalRequired: true,
    });
    svc.execute.mockResolvedValue({ success: false, error: 'Registrar rejected' });

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'execute', 'example.com', '--yes']);
    });

    expect(out).toContain('Purchase failed');
    expect(out).toContain('Registrar rejected');
    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });

  it('handles PurchaseNotApprovedError', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: null,
      confidence: null,
      suggestedBuyMax: null,
      trademarkClear: true,
      operatorApprovalRequired: true,
    });
    svc.execute.mockRejectedValue(new PurchaseNotApprovedError('example.com', 'test'));

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'execute', 'example.com', '--yes']);
    });

    expect(out).toContain('Operator approval required');
    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });
});

describe('CLI: dominus buy price', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints prices for domains', async () => {
    const svc = createMockPurchaseService();
    svc.checkPrice.mockResolvedValue([
      {
        domain: 'foo.com',
        available: true,
        registerPriceEur: 10,
        renewalPriceEur: 10,
        transferPriceEur: 10,
        checkedAt: new Date().toISOString(),
      },
    ]);

    const program = new Command();
    registerBuyCommand(program, { purchaseService: svc });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'buy', 'price', 'foo.com']);
    });

    expect(out).toContain('AVAILABLE');
    expect(out).toContain('€10.00');
  });
});
