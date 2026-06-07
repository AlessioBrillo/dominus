import type { Command } from 'commander';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import { isValidDomain, parseDomain } from '../../utils/domain.js';

export function registerScoreCommand(program: Command, engine: ScoringEngine): void {
  program
    .command('score <domain>')
    .description('Score a single domain and display the result')
    .option('--closeout', 'Treat domain as a closeout/expired domain', false)
    .option('--age <years>', 'Domain age in years (for closeout scoring)', parseFloat)
    .option('--backlinks <count>', 'Number of backlinks (for closeout scoring)', parseInt)
    .action(
      (
        domain: string,
        options: { closeout: boolean; age?: number; backlinks?: number },
      ) => {
        if (!isValidDomain(domain)) {
          process.stderr.write(
            `Error: '${domain}' is not a syntactically valid domain. Expected something like 'example.com'.\n`,
          );
          process.exit(1);
        }

        // Use the shared parser so the CLI prints the same TLD/SLD the
        // pipeline would (fixes the multi-part TLD bug for ad-hoc scoring).
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
          .then((result) => {
            process.stdout.write(`\nScore: ${domain}\n`);
            process.stdout.write(`  Expected value:    €${result.expectedValue.toFixed(2)}\n`);
            process.stdout.write(`  Suggested buy max: €${result.suggestedBuyMax.toFixed(2)}\n`);
            process.stdout.write(`  List price:        €${result.suggestedListPrice.toFixed(2)}\n`);
            process.stdout.write(`  Confidence:        ${(result.confidence * 100).toFixed(1)}%\n`);
            process.stdout.write(`  Recommended:       ${result.recommended ? 'YES' : 'NO'}\n`);
          })
          .catch((err: unknown) => {
            process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
          });
      },
    );
}
