import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerPortfolioCommand } from '../commands/portfolio-command.js';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

function makeMockManager(
  opts: {
    entries?: Array<{ domain: string; verdict?: string }>;
    rescoreResult?: unknown;
    rescoreShouldThrow?: boolean;
  } = {},
): PortfolioManager & {
  rescoreAll: ReturnType<typeof vi.fn>;
  refreshVerdicts: ReturnType<typeof vi.fn>;
} {
  const entries = opts.entries ?? [];
  return {
    list: vi.fn().mockReturnValue(
      entries.map((e) => ({
        entry: {
          domain: e.domain,
          tld: '.com',
          acquiredAt: '2025-01-01T00:00:00.000Z',
          renewalDate: '2026-12-31T00:00:00.000Z',
          acquisitionCost: 12,
          renewalCost: 12,
          registrar: 'namecheap',
          verdict: e.verdict ?? 'keep',
        },
        renewalClock: { daysUntilRenewal: 90, renewalCost: 12 },
      })),
    ),
    rescoreAll: opts.rescoreShouldThrow
      ? vi.fn().mockRejectedValue(new Error('upstream down'))
      : vi.fn().mockResolvedValue(
          opts.rescoreResult ?? {
            totalDurationMs: 42,
            results: entries.map((e) => ({
              domain: e.domain,
              weightedScore: 0.5,
              calibratedScore: 50,
              suggestedListPrice: 600,
              expectedValue: 200,
              confidence: 0.6,
              trademarkClear: true,
              trademarkVerdict: GateVerdict.Clear,
              verifiedSources: ['USPTO', 'EUIPO'],
            })),
          },
        ),
    refreshVerdicts: vi.fn(),
  } as unknown as PortfolioManager & {
    rescoreAll: ReturnType<typeof vi.fn>;
    refreshVerdicts: ReturnType<typeof vi.fn>;
  };
}

type Spy = { mock: { calls: unknown[][] }; mockClear(): void; mockRestore(): void };

let stdoutSpy: Spy | undefined;
let exitSpy: Spy | undefined;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write') as unknown as Spy;
  stdoutSpy.mockClear();
  exitSpy = vi.spyOn(process, 'exit') as unknown as Spy;
  exitSpy.mockClear();
});

afterEach(() => {
  stdoutSpy?.mockRestore();
  exitSpy?.mockRestore();
});

function stdoutText(): string {
  return (stdoutSpy?.mock.calls ?? []).map((c) => String(c[0])).join('');
}

describe('registerPortfolioCommand.rescore', () => {
  it('registers a "rescore" subcommand', () => {
    const program = new Command();
    const manager = makeMockManager();
    registerPortfolioCommand(program, { manager });
    const portfolioCmd = program.commands.find((c) => c.name() === 'portfolio');
    const rescoreCmd = portfolioCmd?.commands.find((c) => c.name() === 'rescore');
    expect(rescoreCmd).toBeDefined();
  });

  it('prints a friendly message and returns early on an empty portfolio', async () => {
    const program = new Command();
    program.exitOverride();
    const manager = makeMockManager({ entries: [] });
    registerPortfolioCommand(program, { manager });

    await program.parseAsync(['node', 'cli', 'portfolio', 'rescore']);

    expect(stdoutText()).toMatch(/empty/i);
    expect(manager.rescoreAll).not.toHaveBeenCalled();
  });

  it('calls rescoreAll and prints the summary', async () => {
    const program = new Command();
    program.exitOverride();
    const manager = makeMockManager({
      entries: [{ domain: 'alpha.com' }, { domain: 'beta.io' }],
    });
    registerPortfolioCommand(program, { manager });

    await program.parseAsync(['node', 'cli', 'portfolio', 'rescore']);

    expect(manager.rescoreAll).toHaveBeenCalledOnce();
    const allOut = stdoutText();
    expect(allOut).toMatch(/alpha\.com/);
    expect(allOut).toMatch(/beta\.io/);
    expect(allOut).toMatch(/Verdicts refreshed/);
  });

  it('propagates an error from rescoreAll as a parseAsync rejection', async () => {
    const program = new Command();
    program.exitOverride();
    const manager = makeMockManager({
      entries: [{ domain: 'alpha.com' }],
      rescoreShouldThrow: true,
    });
    registerPortfolioCommand(program, { manager });

    // parseAsync rejects because the rescore promise rejected and
    // commander propagates the rejection out of the action.
    await expect(program.parseAsync(['node', 'cli', 'portfolio', 'rescore'])).rejects.toThrow(
      /upstream down/,
    );
  });

  it('honours --quiet to suppress per-domain output', async () => {
    const program = new Command();
    program.exitOverride();
    const manager = makeMockManager({
      entries: [{ domain: 'alpha.com' }],
    });
    registerPortfolioCommand(program, { manager });

    await program.parseAsync(['node', 'cli', 'portfolio', 'rescore', '--quiet']);

    const allOut = stdoutText();
    // Summary line still appears; the per-domain table does not.
    expect(allOut).toMatch(/Rescore complete/);
    expect(allOut).not.toMatch(/alpha\.com\s+score:/);
  });
});
