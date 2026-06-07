import type { Command } from 'commander';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { DomainCandidate } from '../../types/candidate.js';

export interface CandidatesCommandDeps {
  candidateRepo: CandidateRepository;
}

export function registerCandidatesCommand(program: Command, deps: CandidatesCommandDeps): void {
  const candidates = program.command('candidates').description('Browse persisted candidates');

  candidates
    .command('list')
    .description('List the most recent candidates')
    .option('--limit <n>', 'Maximum rows to return', (v: string) => Number.parseInt(v, 10), 50)
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((options: { limit: number; json: boolean }) => {
      const rows = deps.candidateRepo.findAll(options.limit);
      if (rows.length === 0) {
        if (options.json) {
          process.stdout.write('[]\n');
        } else {
          process.stdout.write('No candidates recorded yet.\n');
        }
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      process.stdout.write(formatCandidatesTable(rows));
    });
}

function formatCandidatesTable(rows: DomainCandidate[]): string {
  const header = ['ID', 'DOMAIN', 'SOURCE', 'STATUS', 'DNS', 'RDAP', 'PREMIUM', 'UPDATED'];
  const lines: string[] = [header.join('  ')];
  for (const c of rows) {
    lines.push(
      [
        String(c.id).padStart(3),
        c.domain.padEnd(30),
        c.source.padEnd(11),
        c.status.padEnd(10),
        (c.dnsStatus ?? '-').padEnd(10),
        (c.rdapStatus ?? '-').padEnd(8),
        c.isPremium ? 'Y' : 'N',
        c.updatedAt?.slice(0, 10) ?? '-',
      ].join('  '),
    );
  }
  return lines.join('\n') + '\n';
}
