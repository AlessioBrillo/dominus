// SPDX-License-Identifier: AGPL-3.0-only
// Minimal CLI for the schema migration manifest.
//
// Usage:
//   node dist/db/migration-manifest-cli.js --list
//
// Prints the ordered migration names of THIS image, one per line, so a
// deploy script can extract an image's manifest without booting the app:
//   docker run --rm --entrypoint node <image> dist/db/migration-manifest-cli.js --list
//
// Exit codes: 0 on success, 1 on unknown/invalid arguments.
import { getMigrationManifest } from './migration-manifest.js';

function main(argv: string[]): void {
  if (argv.length !== 1 || argv[0] !== '--list') {
    process.stderr.write(
      'Usage: migration-manifest-cli.js --list\n' +
        'Prints the ordered migration names of this image, one per line.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${getMigrationManifest().join('\n')}\n`);
}

main(process.argv.slice(2));
