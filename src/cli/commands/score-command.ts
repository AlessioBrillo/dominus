import type { Command } from 'commander';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import { isValidDomain, parseDomain } from '../../utils/domain.js';

export function registerScoreCommand(
  program: Command,
  engine: ScoringEngine,
  gate?: TrademarkGate,
): void {
  program
    .command('score <domain>')
    .description('Score a single domain and display the result (includes trademark check when available)')
    .option('--closeout', 'Treat domain as a closeout/expired domain', false)
    .option('--age <years>', 'Domain age in years (for closeout scoring)', parseFloat)
    .option('--backlinks <count>', 'Number of backlinks (for closeout scoring)', parseInt)
    .option('--no-tm', 'Skip the trademark gate check', false)
    .action(
      (
        domain: string,
        options: { closeout: boolean; age?: number; backlinks?: number; tm: boolean },
      ) => {
        if (!isValidDomain(domain)) {
          process.stderr.write(
            `Error: '${domain}' is not a syntactically valid domain. Expected something like 'example.com'.\n`,
          );
          process.exit(1);
        }

        const parsed = parseDomain(domain);

        engine
          .score({
            domain,
            tld: parsed.tld,
            sld: parsed.sld,
            isCloseout: options.closeout,
            domainAge: options.age,
            backlinks: options.backlinks,
          })
          .then(async (result) => {
            process.stdout.write(`\nScore: ${domain}\n`);
            process.stdout.write(`  Expected value:    €${result.expectedValue.toFixed(2)}\n`);
            process.stdout.write(`  Suggested buy max: €${result.suggestedBuyMax.toFixed(2)}\n`);
            process.stdout.write(`  List price:        €${result.suggestedListPrice.toFixed(2)}\n`);
            process.stdout.write(`  Confidence:        ${(result.confidence * 100).toFixed(1)}%\n`);
            process.stdout.write(`  Recommended:       ${result.recommended ? 'YES' : 'NO'}\n`);

            if (gate !== undefined && options.tm) {
              try {
                const gateResult = await gate.check(domain);
                process.stdout.write(`\n  Trademark gate:\n`);
                process.stdout.write(`    Verdict:         ${gateResult.verdict}\n`);
                process.stdout.write(`    Sources:         ${gateResult.verifiedSources.join(', ') || 'none'}\n`);
                if (gateResult.verdict === GateVerdict.Blocked) {
                  process.stdout.write(`    Matched mark:    ${gateResult.matchedMark ?? 'unknown'}\n`);
                  process.stdout.write(`    Matched owner:   ${gateResult.matchedOwner ?? 'unknown'}\n`);
                  process.stdout.write(`    Source:          ${gateResult.matchSource ?? 'unknown'}\n`);
                }
                if (gateResult.partial) {
                  process.stdout.write(`    (partial result — one trademark source did not respond)\n`);
                }
                if (gateResult.usptoFailed) {
                  process.stdout.write(`    (USPTO unavailable — US-market domain requires USPTO clearance)\n`);
                }
              } catch (err: unknown) {
                process.stdout.write(`    Trademark gate error: ${err instanceof Error ? err.message : String(err)}\n`);
              }
            }
          })
          .catch((err: unknown) => {
            process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
          });
      },
    );
}
