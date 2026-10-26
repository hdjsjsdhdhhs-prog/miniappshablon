import { readFileSync } from 'node:fs';
import { assertExpectedProductionMigrationPlan } from './lib/migration-plan.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: tsx scripts/check-production-migration-plan.ts <dry-run-log>');

assertExpectedProductionMigrationPlan(readFileSync(file, 'utf8'));
console.log('Dry-run contains exactly the two reviewed production migrations in order.');
