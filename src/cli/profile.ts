// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The CLI profiles.
 *
 * The CLI has two kinds of commands:
 *
 *   - DECISION commands answer a question about a domain and write
 *     nothing down. They need the scoring engine and the trademark gate,
 *     and nothing else: no database, no job queue, no worker, no
 *     resolver, no RDAP bootstrap.
 *   - FULL commands read or write the user's portfolio, the run history or
 *     the configuration. They need the whole application.
 *
 * The profile is resolved from the command line BEFORE the dependencies are
 * built, because building them is the expensive part: the full profile
 * opens the database, applies the migrations, starts the job worker and
 * probes the resolver, and none of that is needed to score one domain.
 */
export type CliProfile = 'decision' | 'full' | 'catalog';

/**
 * The commands that run without persistence.
 *
 * A command that writes down a result (a score, a run, a purchase) is NOT
 * in this list: the decision is only a decision until it is recorded, and
 * the record is the point of the command.
 */
export const DECISION_COMMANDS: ReadonlySet<string> = new Set(['score']);

/**
 * The command the invocation names, or undefined when it names none.
 *
 * The first argument that is not an option is the command name. Options
 * before the command (`dominus --verbose score x`) do not change it.
 */
export function resolveCliCommand(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((arg) => !arg.startsWith('-'));
}

/**
 * Resolve the profile of an invocation.
 *
 * The profile is resolved from the command line BEFORE the dependencies are
 * built, because building them is the expensive part: the full profile
 * opens the database, applies the migrations, starts the job worker and
 * probes the resolver, and none of that is needed to score one domain.
 *
 * The **catalog** profile answers the invocations that name no command:
 * `--help`, `--version` and a bare `dominus`. They print the command line
 * and nothing else, so they must not cost an application.
 */
export function resolveCliProfile(argv: readonly string[]): CliProfile {
  const command = resolveCliCommand(argv);
  if (command === undefined) return 'catalog';
  return DECISION_COMMANDS.has(command) ? 'decision' : 'full';
}
