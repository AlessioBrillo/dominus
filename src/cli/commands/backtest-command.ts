import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BacktestEngine, WeightSuggester } from '../../scoring/backtest/index.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import { loadConfig } from '../../config.js';
import type { BacktestReport, WeightSuggestionReport } from '../../scoring/backtest/index.js';

export interface BacktestCommandDeps {
  db: Database.Database;
  outcomeRepo: OutcomeRepository;
}

const DEFAULT_OVERRIDE_PATH = './data/weights-override.json';

export function registerBacktestCommand(program: Command, deps: BacktestCommandDeps): void {
  const backtest = program
    .command('backtest')
    .description('Backtest the scoring engine against realised outcomes (sold only)');

  const makeEngine = (): BacktestEngine =>
    new BacktestEngine(deps.db, deps.outcomeRepo, new BacktestSignalsRepository(deps.db));

  const makeSuggester = (): WeightSuggester =>
    new WeightSuggester(deps.db, new BacktestSignalsRepository(deps.db), new ScoringRepository(deps.db));

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

  backtest
    .command('suggest-weights')
    .description('Propose per-signal weight adjustments based on the backtest signals (manual approval required)')
    .option('--json', 'emit machine-readable JSON instead of a human report', false)
    .option('--apply', 'persist the suggestion to data/weights-override.json (no auto-activation)', false)
    .action((options: { json: boolean; apply: boolean }) => {
      const suggester = makeSuggester();
      const report = suggester.suggest();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatSuggestionReport(report));
      }
      if (report.warnings.length > 0 && !options.apply) {
        process.stdout.write(`\nWarnings:\n${report.warnings.map((w) => `  - ${w}`).join('\n')}\n`);
      }
      if (options.apply) {
        if (report.sampleSize < 5) {
          process.stderr.write('Refusing to apply: sample size below the 5-sold-outcome minimum.\n');
          process.exit(1);
        }
        if (!report.sumsToOne) {
          process.stderr.write('Refusing to apply: suggested weights do not sum to 1.0.\n');
          process.exit(1);
        }
        const config = loadConfig();
        const targetPath = resolve(process.cwd(), config.SCORING_WEIGHTS_OVERRIDE ?? DEFAULT_OVERRIDE_PATH);
        if (!targetPath.startsWith(resolve(process.cwd(), './data'))) {
          process.stderr.write(`Refusing to write outside ./data: ${targetPath}\n`);
          process.exit(1);
        }
        const payload = {
          generatedAt: report.generatedAt,
          sampleSize: report.sampleSize,
          weights: Object.fromEntries(
            report.suggestions.map((s) => [s.signal, s.suggestedWeight]),
          ),
        };
        writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        process.stdout.write(
          `\nWrote weights override to ${targetPath}.\n` +
            `Set SCORING_WEIGHTS_OVERRIDE=${targetPath} in .env to activate it.\n`,
        );
      }
    });
}

function formatSuggestionReport(r: WeightSuggestionReport): string {
  const lines: string[] = [];
  lines.push(`DOMINUS weight suggester — generated ${r.generatedAt}`);
  lines.push(`Sample: ${r.sampleSize} sold outcome(s)`);
  lines.push(`Current total weight: ${r.totalCurrentWeight.toFixed(3)}`);
  lines.push(`Suggested total weight: ${r.totalSuggestedWeight.toFixed(3)}${r.sumsToOne ? '' : '  (WARNING: does not sum to 1)'}`);
  lines.push('');
  lines.push(
    `  ${'signal'.padEnd(11)}  ${'current'.padStart(8)}  ${'suggested'.padStart(9)}  ${'delta'.padStart(8)}  ${'action'.padEnd(7)}  rationale`,
  );
  for (const s of r.suggestions) {
    const deltaStr = `${s.delta >= 0 ? '+' : ''}${(s.delta * 100).toFixed(1)}%`;
    lines.push(
      `  ${s.signal.padEnd(11)}  ${(s.currentWeight * 100).toFixed(1).padStart(7)}%  ${(s.suggestedWeight * 100).toFixed(1).padStart(8)}%  ${deltaStr.padStart(8)}  ${s.action.padEnd(7)}  ${s.rationale}`,
    );
  }
  lines.push('');
  lines.push('Run `dominus backtest suggest-weights --apply` to persist the suggestion to data/weights-override.json.');
  lines.push('The engine does NOT pick it up automatically — set SCORING_WEIGHTS_OVERRIDE in .env to activate.');
  return lines.join('\n');
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
