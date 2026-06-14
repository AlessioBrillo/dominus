import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerAnalyticsCommand } from '../analytics-command.js';
import type { PredictionAccuracyAnalyzer } from '../../../analytics/index.js';

function makeStubAnalyzer(): PredictionAccuracyAnalyzer {
  return {
    refresh: vi.fn().mockReturnValue({
      scanned: 5,
      included: 4,
      skippedNoScore: 1,
      skippedNoOutcome: 0,
    }),
    generate: vi.fn().mockReturnValue({
      generatedAt: '2026-06-14T12:00:00.000Z',
      sampleSize: 4,
      overall: {
        mape: 25.5,
        medianApe: 20.0,
        mae: 30,
        rmse: 45.2,
        bias: -10,
        biasPct: -15.5,
        sampleSize: 3,
      },
      confusionMatrix: {
        truePositives: 2,
        falsePositives: 1,
        trueNegatives: 1,
        falseNegatives: 0,
        precision: 0.667,
        recall: 1.0,
        f1: 0.8,
      },
      byTld: [
        { tld: '.com', sampleSize: 3, mape: 20.0, bias: -5, meanPredicted: 150, meanActual: 155 },
      ],
      calibration: {
        low: { n: 1, meanAbsError: 10, meanRealised: 50, meanPredicted: 45 },
        mid: { n: 2, meanAbsError: 25, meanRealised: 120, meanPredicted: 100 },
        high: { n: 1, meanAbsError: 15, meanRealised: 200, meanPredicted: 210 },
      },
      bySignalAvailability: [
        {
          signal: 'commercial',
          available: {
            mape: 15,
            medianApe: 15,
            mae: 20,
            rmse: 25,
            bias: -5,
            biasPct: -10,
            sampleSize: 2,
          },
          unavailable: {
            mape: 35,
            medianApe: 35,
            mae: 40,
            rmse: 50,
            bias: 10,
            biasPct: 15,
            sampleSize: 1,
          },
        },
      ],
      trend: [{ period: '2026-06', sampleSize: 2, mape: 20.0, f1: 0.8 }],
      warnings: ["TLD '.io': 1 samples < 10 — accuracy metrics not statistically significant"],
    }),
    findScoringRunBefore: vi.fn(),
  } as unknown as PredictionAccuracyAnalyzer;
}

describe('analytics command', () => {
  let program: Command;
  let stubAnalyzer: PredictionAccuracyAnalyzer;

  beforeEach(() => {
    program = new Command();
    stubAnalyzer = makeStubAnalyzer();
    registerAnalyticsCommand(program, { accuracyAnalyzer: stubAnalyzer });
  });

  it('registers analytics subcommands', () => {
    const cmd = program.commands.find((c) => c.name() === 'analytics');
    expect(cmd).toBeDefined();
  });

  it('analytics refresh calls refresh() and prints summary', async () => {
    const cmd = program.commands.find((c) => c.name() === 'analytics');
    expect(cmd).toBeDefined();
  });

  it('analytics accuracy --json emits valid JSON', async () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += chunk;
      return true;
    });

    await program.parseAsync(['node', 'test', 'analytics', 'accuracy', '--json']);

    expect(stubAnalyzer.generate).toHaveBeenCalled();
    const parsed = JSON.parse(output);
    expect(parsed.sampleSize).toBe(4);
    expect(parsed.confusionMatrix).toBeDefined();

    spy.mockRestore();
  });
});
