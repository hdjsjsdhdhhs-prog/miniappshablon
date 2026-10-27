// Usage:
//   tsx scripts/check-production-migration-plan.ts plan <migration-list.json> <dry-run.json>
//     → prints the decision and writes `mode=apply|skip` to $GITHUB_OUTPUT; exits non-zero on anything else.
//   tsx scripts/check-production-migration-plan.ts verify-applied <migration-list.json>
//     → exits non-zero unless the history confirms every local migration (incl. the release) as applied.
import { appendFileSync, readFileSync } from 'node:fs';
import { assertReleaseApplied, decideProductionMigrationPlan, EXPECTED_PRODUCTION_MIGRATIONS } from './lib/migration-plan.ts';

const [command, listFile, dryRunFile] = process.argv.slice(2);
const read = (file: string | undefined) => {
  if (!file) throw new Error('Usage: check-production-migration-plan.ts plan <list.json> <dry-run.json> | verify-applied <list.json>');
  return readFileSync(file, 'utf8');
};
const release = EXPECTED_PRODUCTION_MIGRATIONS.join(', ');

try {
  if (command === 'plan') {
    const mode = decideProductionMigrationPlan(read(listFile), read(dryRunFile));
    console.log(
      mode === 'apply'
        ? `Plan: apply exactly ${release} (both pending, history consistent, dry-run matches).`
        : `Plan: skip db push — ${release} confirmed applied in remote history, dry-run up to date.`,
    );
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
  } else if (command === 'verify-applied') {
    assertReleaseApplied(read(listFile));
    console.log(`Verified: remote history has ${release} applied and nothing pending.`);
  } else {
    read(undefined);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (command === 'plan') console.error('Deployment stopped before any database change.');
  process.exit(1);
}
