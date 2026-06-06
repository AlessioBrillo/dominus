import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import { BacktestEngine } from '../../scoring/backtest/index.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import type { BacktestReport } from '../../scoring/backtest/index.js';

export interface BacktestCommandDeps {
  db: Database.Database;
  outcomeRepo: OutcomeRepository;
}

export function registerBacktestCommand(program: Command, deps: BacktestCommandDeps): void {
  const backtest = program
    .command('backtest')
    .description('Backtest the scoring engine against realised outcomes (sold only)');

  const makeEngine = (): BacktestEngine =>
    new BacktestEngine(deps.db, deps.outcomeRepo, new BacktestSignalsRepository(deps.db));

  backtest
    .command('snapshot')
    .description('Rebuild the backtest_signals table from current outcomes and scoring_runs (idempotent)')
    .action(() => {
      const engine = makeEngine();
      const summary = engine.snapshot();
      process.stdout.write(
        `Snapshot: scanned ${summary.scanned} sold outcomes, ` +
          `inserted ${summary.inserted}, skipped ${summary.skipped}\n`,
      );
    });

  backtest
    .command('report')
    .description('Aggregate the backtest_signals table into MAE, bias, and per-bucket calibration')
    .option('--json', 'emit machine-readable JSON instead of a human report', false)
    .action((options: { json: boolean }) => {
      const engine = makeEngine();
      const report = engine.report();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(formatReport(report));
    });

  backtest
    .command('run')
    .description('Snapshot the backtest_signals table, then print the aggregated report')
    .option('--json', 'emit machine-readable JSON instead of a human report', false)
    .option('--no-snapshot', 'skip the snapshot step and report on the existing table')
    .action((options: { json: boolean; snapshot: boolean }) => {
      const engine = makeEngine();
      let snapshotNote = '';
      if (options.snapshot) {
        const summary = engine.snapshot();
        snapshotNote = `Snapshot: scanned ${summary.scanned}, inserted ${summary.inserted}, skipped ${summary.skipped}\n\n`;
      }
      const report = engine.report();
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ snapshot: snapshotNote, report }, null, 2)}\n`);
        return;
      }
      process.stdout.write(snapshotNote);
      process.stdout.write(formatReport(report));
    });
}

function formatReport(r: BacktestReport): string {
  if (r.sampleSize === 0) {
    return (
      'Backtest report — 0 sold outcomes in sample.\n' +
      'Record at least one "sold" outcome with sale_price_eur, then run `dominus backtest run`.\n'
    );
  }

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const eur = (x: number): string => `€${x.toFixed(0)}`;
  const eur2 = (x: number): string => `€${x.toFixed(2)}`;

  const lines: string[] = [];
  lines.push(`DOMINUS backtest — generated ${r.generatedAt}`);
  lines.push(`Sample: ${r.sampleSize} sold outcome(s)`);
  lines.push('');
  lines.push('Error on expected_value:');
  lines.push(`  MAE      ${eur(r.meanAbsoluteErrorEur)}`);
  lines.push(`  Median   ${eur(r.medianAbsoluteErrorEur)}`);
  lines.push(`  Bias     ${eur(r.biasEur)}  (over-predicting when negative, ${r.biasPct.toFixed(1)}% of mean realised)`);
  lines.push('');
  lines.push('Buy-max accuracy (the metric that matters for capital):');
  lines.push(`  MAE         ${eur(r.buyMaxMeanAbsoluteErrorEur)}`);
  lines.push(`  Hit rate    ${pct(r.buyMaxHitRate)}  (sale_price > suggested_buy_max)`);
  lines.push('');
  lines.push('Confidence calibration:');
  lines.push(
    `  ${'bucket'.padEnd(6)}  ${'n'.padStart(3)}  ${'MAE'.padStart(8)}  ${'realised'.padStart(10)}  ${'predicted'.padStart(10)}`,
  );
  for (const bucket of ['low', 'mid', 'high'] as const) {
    const c = r.calibration[bucket];
    lines.push(
      `  ${bucket.padEnd(6)}  ${String(c.n).padStart(3)}  ${eur(c.meanAbsError).padStart(8)}  ${eur(c.meanRealised).padStart(10)}  ${eur(c.meanPredicted).padStart(10)}`,
    );
  }
  lines.push('');
  lines.push(`Report MAE: ${eur2(r.meanAbsoluteErrorEur)}`);
  return lines.join('\n');
}
