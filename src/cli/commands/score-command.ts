// SPDX-License-Identifier: AGPL-3.0-only
import type { Command } from 'commander';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import { isValidDomain } from '../../utils/domain.js';

export function registerScoreCommand(
  program: Command,
  engine: ScoringEngine,
  gate?: TrademarkGate,
): void {
  program
    .command('score <domain>')
    .description(
      'Score a single domain and display the result (includes trademark check when available)',
    )
    .option('--closeout', 'Treat domain as a closeout/expired domain', false)
    .option('--age <years>', 'Domain age in years (for closeout scoring)', parseFloat)
    .option('--backlinks <count>', 'Number of backlinks (for closeout scoring)', parseInt)
    .option('--json', 'Print the decision as JSON (machine-readable)', false)
    .action(
      async (
        domain: string,
        options: { closeout: boolean; age?: number; backlinks?: number; json: boolean },
      ) => {
        if (!isValidDomain(domain)) {
          process.stderr.write(
            `Error: '${domain}' is not a syntactically valid domain. Expected something like 'example.com'.\n`,
          );
          process.exit(1);
        }

        // The trademark gate runs FIRST, before the score is printed: a buy
        // recommendation that is later withdrawn by a trademark match would
        // be a decision the reader already acted on. The gate is not
        // optional (Principle 6) - a domain that no register answered for
        // is never recommended.
        let trademarkClear = false;
        let gateVerdict = 'not-run';
        let gateSources: string[] = [];
        let gatePartial = false;
        let gateMark: string | undefined;
        let gateMarkSource: string | undefined;

        if (gate !== undefined) {
          try {
            const gateResult = await gate.check(domain);
            trademarkClear = gateResult.verdict === GateVerdict.Clear;
            gateVerdict = gateResult.verdict;
            gateSources = gateResult.verifiedSources;
            gatePartial = gateResult.partial === true;
            gateMark = gateResult.matchedMark;
            gateMarkSource = gateResult.matchSource;
          } catch (err: unknown) {
            gateVerdict = 'error';
            process.stderr.write(
              `Trademark gate error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }

        let result;
        try {
          result = await engine.score({
            domain,
            // TLD and SLD are derived internally by ScoringEngine
            // from the authoritative PSL-based domain parser.
            isCloseout: options.closeout,
            domainAge: options.age,
            backlinks: options.backlinks,
          });
        } catch (err: unknown) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }

        const recommended = result.recommended && trademarkClear;

        if (options.json) {
          // The machine-readable form of the same decision. stdout carries
          // exactly this object and nothing else, so it can be piped.
          process.stdout.write(
            `${JSON.stringify(
              {
                domain,
                score: { ...result, recommended },
                trademark: {
                  verdict: gateVerdict,
                  sources: gateSources,
                  partial: gatePartial,
                  ...(gateMark !== undefined ? { matchedMark: gateMark } : {}),
                  ...(gateMarkSource !== undefined ? { matchSource: gateMarkSource } : {}),
                },
                recommended,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        // The decision first (Principle 2: one question, buy or pass), then
        // the evidence behind it.
        process.stdout.write(`\nScore: ${domain}\n`);
        process.stdout.write(`  Expected value:    \u20ac${result.expectedValue.toFixed(2)}\n`);
        process.stdout.write(`  Suggested buy max: \u20ac${result.suggestedBuyMax.toFixed(2)}\n`);
        process.stdout.write(
          `  List price:        \u20ac${result.suggestedListPrice.toFixed(2)}\n`,
        );
        process.stdout.write(`  Confidence:        ${(result.confidence * 100).toFixed(1)}%\n`);
        process.stdout.write(
          `  Recommended:       ${recommended ? 'YES' : 'NO'} (TM ${gateVerdict})\n`,
        );
        process.stdout.write(`\n  Trademark gate:\n`);
        process.stdout.write(`    Verdict:   ${gateVerdict}\n`);
        process.stdout.write(`    Sources:   ${gateSources.join(', ') || 'none'}\n`);
        if (gateMark !== undefined) {
          process.stdout.write(`    Mark:      ${gateMark}\n`);
          process.stdout.write(`    Source:    ${gateMarkSource ?? 'unknown'}\n`);
        }
        if (gatePartial) {
          process.stdout.write(
            `    (partial result - one trademark source did not respond; the verdict is the clear one, not a verified one)\n`,
          );
        }
        if (gateVerdict === GateVerdict.Unverified) {
          process.stdout.write(
            `    (unverified - no trademark source answered; a domain in this state is never recommended)\n`,
          );
        }
        if (!recommended && result.recommended) {
          process.stdout.write(
            `    (the score alone recommends this domain; the trademark gate does not clear it)\n`,
          );
        }
      },
    );
}
