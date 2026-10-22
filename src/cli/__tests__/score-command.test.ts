// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerScoreCommand } from '../commands/score-command.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

function makeStubEngine(): ScoringEngine {
  return {
    score: () =>
      Promise.resolve({
        domain: 'example.com',
        expectedValue: 100,
        confidence: 0.5,
        suggestedBuyMax: 50,
        suggestedListPrice: 200,
        weightedScore: 0.5,
        breakdown: {} as never,
        recommended: true,
        scoredAt: new Date().toISOString(),
      }),
  } as unknown as ScoringEngine;
}

function buildProgram(): Command {
  const program = new Command();
  registerScoreCommand(program, makeStubEngine());
  return program;
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = original;
    })
    .then((): string => buffer);
}

function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stderr.write = original;
    })
    .then((): string => buffer);
}

describe('CLI: dominus score (input validation)', () => {
  let program: Command;

  beforeEach(() => {
    program = buildProgram();
  });

  it('accepts a valid domain and runs the engine', async () => {
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'score', 'example.com']);
    });
    expect(out).toMatch(/Score: example\.com/);
    expect(out).toMatch(/Expected value/);
  });

  it('rejects a domain with no TLD and writes to stderr with exit 1', async () => {
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'score', 'noTld']);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/not a syntactically valid domain/);
  });

  it('rejects a domain with an invalid character (underscore)', async () => {
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'score', 'bad_name.com']);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/not a syntactically valid domain/);
  });

  it('rejects a domain whose label starts with a hyphen', async () => {
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'score', '--', '-bad.com']);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/not a syntactically valid domain/);
  });

  it('rejects a single-letter TLD', async () => {
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'score', 'example.c']);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/not a syntactically valid domain/);
  });

  // ── The machine-readable form ─────────────────────────────────────

  it('prints the decision as JSON and nothing else', async () => {
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'score', 'example.com', '--json']);
    });
    // stdout must be parseable as JSON on its own: a command whose output
    // carries log lines cannot be piped.
    const parsed = JSON.parse(out) as {
      domain: string;
      recommended: boolean;
      score: { expectedValue: number; suggestedBuyMax: number };
      trademark: { verdict: string };
    };
    expect(parsed.domain).toBe('example.com');
    expect(parsed.score.expectedValue).toBe(100);
    expect(parsed.score.suggestedBuyMax).toBe(50);
    // No trademark gate was given: the domain could not be checked, and a
    // domain that could not be checked is never recommended (Principle 6).
    expect(parsed.recommended).toBe(false);
    expect(parsed.trademark.verdict).toBe('not-run');
  });

  it('recommends a domain the trademark gate cleared', async () => {
    const clearGate = {
      check: () =>
        Promise.resolve({
          domain: 'example.com',
          verdict: GateVerdict.Clear,
          verifiedSources: ['USPTO'],
        }),
    } as unknown as TrademarkGate;

    const cleared = new Command();
    registerScoreCommand(cleared, makeStubEngine(), clearGate);
    const out = await captureStdout(async () => {
      await cleared.parseAsync(['node', 'dominus', 'score', 'example.com', '--json']);
    });
    const parsed = JSON.parse(out) as { recommended: boolean; trademark: { verdict: string } };
    expect(parsed.recommended).toBe(true);
    expect(parsed.trademark.verdict).toBe(GateVerdict.Clear);
  });

  it('never recommends a domain the trademark gate did not clear', async () => {
    const blockedGate = {
      check: () =>
        Promise.resolve({
          domain: 'example.com',
          verdict: GateVerdict.Blocked,
          verifiedSources: ['USPTO'],
          matchedMark: 'EXAMPLE',
          matchSource: 'USPTO',
        }),
    } as unknown as TrademarkGate;

    const blocked = new Command();
    registerScoreCommand(blocked, makeStubEngine(), blockedGate);
    const out = await captureStdout(async () => {
      await blocked.parseAsync(['node', 'dominus', 'score', 'example.com', '--json']);
    });
    const parsed = JSON.parse(out) as { recommended: boolean; trademark: { matchedMark: string } };
    expect(parsed.recommended).toBe(false);
    expect(parsed.trademark.matchedMark).toBe('EXAMPLE');
  });
});
