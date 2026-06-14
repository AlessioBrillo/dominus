import type { Command } from 'commander';
import type { PredictionAccuracyAnalyzer, AccuracyReport } from '../../analytics/index.js';

export interface AnalyticsCommandDeps {
  accuracyAnalyzer: PredictionAccuracyAnalyzer;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const eur = (x: number): string => `€${x.toFixed(2)}`;
const pad = (s: string, len: number): string => s.padEnd(len);

export function registerAnalyticsCommand(program: Command, deps: AnalyticsCommandDeps): void {
  const analytics = program
    .command('analytics')
    .description('Prediction accuracy and portfolio performance analytics');

  analytics
    .command('refresh')
    .description(
      'Rebuild the outcome_scores table by joining outcomes with their last scoring run (idempotent)',
    )
    .action(() => {
      const summary = deps.accuracyAnalyzer.refresh();
      process.stdout.write(
        `Refresh: scanned ${summary.scanned} outcomes, ` +
          `included ${summary.included}, ` +
          `skipped (no score) ${summary.skippedNoScore}, ` +
          `skipped (no outcome) ${summary.skippedNoOutcome}\n`,
      );
    });

  analytics
    .command('accuracy')
    .description('Generate a full accuracy report: confusion matrix, per-TLD, calibration, trends')
    .option('--json', 'emit machine-readable JSON instead of human report', false)
    .action((options: { json: boolean }) => {
      const report = deps.accuracyAnalyzer.generate();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(formatAccuracyReport(report));
    });

  analytics
    .command('run')
    .description('Refresh outcome_scores, then print the accuracy report')
    .option('--json', 'emit machine-readable JSON instead of human report', false)
    .option('--no-refresh', 'skip the refresh step and report on the existing table')
    .action((options: { json: boolean; refresh: boolean }) => {
      let refreshNote = '';
      if (options.refresh) {
        const summary = deps.accuracyAnalyzer.refresh();
        refreshNote = `Refresh: scanned ${summary.scanned}, included ${summary.included}\n\n`;
      }
      const report = deps.accuracyAnalyzer.generate();
      if (options.json) {
        process.stdout.write(JSON.stringify({ refresh: refreshNote, report }, null, 2));
        process.stdout.write('\n');
        return;
      }
      process.stdout.write(refreshNote);
      process.stdout.write(formatAccuracyReport(report));
    });
}

function formatAccuracyReport(r: AccuracyReport): string {
  if (r.sampleSize === 0) {
    return (
      'Accuracy report — 0 outcome scores in sample.\n' +
      'Record at least one outcome, then run `dominus analytics refresh` first.\n'
    );
  }

  const lines: string[] = [];
  lines.push(`DOMINUS prediction accuracy — generated ${r.generatedAt}`);
  lines.push(`Sample: ${r.sampleSize} outcome score(s)`);
  lines.push('');

  lines.push('Overall (sold with price):');
  lines.push(`  MAPE      ${r.overall.mape.toFixed(1)}%`);
  lines.push(`  Median    ${r.overall.medianApe.toFixed(1)}%`);
  lines.push(`  MAE       ${eur(r.overall.mae)}`);
  lines.push(`  RMSE      ${eur(r.overall.rmse)}`);
  lines.push(
    `  Bias      ${eur(r.overall.bias)}  (${r.overall.biasPct.toFixed(1)}% of mean realised)`,
  );
  lines.push('');

  const cm = r.confusionMatrix;
  lines.push('Confusion matrix (recommendation accuracy):');
  lines.push(`  True Positives     ${cm.truePositives}  (recommended + sold)`);
  lines.push(`  False Positives    ${cm.falsePositives}  (recommended + dropped/expired)`);
  lines.push(`  True Negatives     ${cm.trueNegatives}  (not recommended + dropped/expired)`);
  lines.push(`  False Negatives    ${cm.falseNegatives}  (not recommended + sold)`);
  lines.push(`  Precision          ${pct(cm.precision)}`);
  lines.push(`  Recall             ${pct(cm.recall)}`);
  lines.push(`  F1 Score           ${cm.f1.toFixed(3)}`);
  lines.push('');

  if (r.byTld.length > 0) {
    lines.push('Accuracy by TLD:');
    lines.push(
      `  ${pad('TLD', 8)}  ${pad('n', 4)}  ${pad('MAPE', 8)}  ${pad('bias', 10)}  ${pad('predicted', 10)}  ${pad('realised', 10)}`,
    );
    for (const t of r.byTld) {
      lines.push(
        `  ${pad(t.tld, 8)}  ${String(t.sampleSize).padStart(4)}  ${t.mape.toFixed(1).padStart(7)}%  ${eur(t.bias).padStart(10)}  ${eur(t.meanPredicted).padStart(10)}  ${eur(t.meanActual).padStart(10)}`,
      );
    }
    lines.push('');
  }

  lines.push('Confidence calibration:');
  lines.push(
    `  ${pad('bucket', 6)}  ${pad('n', 3)}  ${pad('MAE', 8)}  ${pad('predicted', 10)}  ${pad('realised', 10)}`,
  );
  for (const bucket of ['low', 'mid', 'high'] as const) {
    const c = r.calibration[bucket]!;
    lines.push(
      `  ${pad(bucket, 6)}  ${String(c.n).padStart(3)}  ${eur(c.meanAbsError).padStart(8)}  ${eur(c.meanPredicted).padStart(10)}  ${eur(c.meanRealised).padStart(10)}`,
    );
  }
  lines.push('');

  lines.push('Accuracy by signal availability (sold with price):');
  for (const s of r.bySignalAvailability) {
    lines.push(`  ${s.signal}:`);
    lines.push(
      `    available:   MAE ${eur(s.available.mae)}  MAPE ${s.available.mape.toFixed(1)}%  n=${s.available.sampleSize}`,
    );
    lines.push(
      `    unavailable: MAE ${eur(s.unavailable.mae)}  MAPE ${s.unavailable.mape.toFixed(1)}%  n=${s.unavailable.sampleSize}`,
    );
  }
  lines.push('');

  if (r.trend.length > 0) {
    lines.push('Accuracy trend (monthly):');
    lines.push(`  ${pad('period', 8)}  ${pad('n', 4)}  ${pad('MAPE', 8)}  ${pad('F1', 8)}`);
    for (const t of r.trend) {
      lines.push(
        `  ${pad(t.period, 8)}  ${String(t.sampleSize).padStart(4)}  ${t.mape.toFixed(1).padStart(7)}%  ${t.f1.toFixed(3).padStart(8)}`,
      );
    }
    lines.push('');
  }

  if (r.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of r.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
