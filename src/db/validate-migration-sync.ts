import { validateMigrationSync } from './migrator.js';

const errors = validateMigrationSync();
if (errors.length === 0) {
  console.log('✓ All migrations have PostgreSQL (upPg) equivalents');
  process.exit(0);
}

console.error(`Migration drift detected (${errors.length} issue(s)):\n`);
for (const err of errors) {
  console.error(`  • ${err}`);
}
process.exit(1);
