// Usage:
//   tsx scripts/check-production-migration-plan.ts plan <migration-list.json> <dry-run.json> [--expect-stages <ids>]
//     → prints the decision and writes `mode=apply|skip` and `stages=<ids>` to $GITHUB_OUTPUT; exits non-zero on
//       anything else. With --expect-stages (comma-separated, e.g. `3A,3B`) it additionally requires an `apply` of
//       exactly those stages — used to re-check the state right before `db push`.
//   tsx scripts/check-production-migration-plan.ts verify-applied <migration-list.json>
//     → exits non-zero unless the history confirms the baseline and every stage as applied, nothing pending.
// Both commands first run the integrity check (scripts/lib/migration-integrity.ts): this repository's
// supabase/migrations (resolved from this script, not from the working directory) must contain exactly the reviewed
// file names, and the canonical SHA-256 of each file must equal its approved hash. The files are re-read and re-hashed
// on every invocation, so the `plan --expect-stages` re-check right before `db push` sees their current content.
import { appendFileSync, readFileSync } from 'node:fs';
import { assertMigrationIntegrity } from './lib/migration-integrity.ts';
import { assertReleaseApplied, decideProductionMigrationPlan, MIGRATION_STAGES } from './lib/migration-plan.ts';

const USAGE =
  'Usage: check-production-migration-plan.ts plan <list.json> <dry-run.json> [--expect-stages <ids>] | verify-applied <list.json>';
const [command, ...args] = process.argv.slice(2);
const read = (file: string | undefined) => {
  if (!file) throw new Error(USAGE);
  return readFileSync(file, 'utf8');
};
const allStages = MIGRATION_STAGES.map((s) => s.id).join(', ');

try {
  const verified = assertMigrationIntegrity();
  console.log(`Integrity: ${verified.length} reviewed migration file(s) match the approved SHA-256.`);
  if (command === 'plan') {
    const [listFile, dryRunFile, flag, expectStages, ...rest] = args;
    if (rest.length > 0 || (flag !== undefined && (flag !== '--expect-stages' || expectStages === undefined))) throw new Error(USAGE);
    const plan = decideProductionMigrationPlan(read(listFile), read(dryRunFile));
    const stages = plan.stages.join(',');
    if (flag !== undefined && (plan.mode !== 'apply' || stages !== expectStages)) {
      throw new Error(`Migration gate: state changed since the plan step: expected apply of ${expectStages}, now ${plan.mode} ${stages}`.trim());
    }
    console.log(
      plan.mode === 'apply'
        ? `Plan: apply whole stage(s) ${stages} — exactly ${plan.files.length} file(s): ${plan.files.join(', ')}. ` +
            'db push applies all of them in this order; history consistent, dry-run matches the reviewed files.'
        : `Plan: skip db push — baseline and stages ${allStages} confirmed applied in remote history, dry-run up to date.`,
    );
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\nstages=${stages}\n`);
  } else if (command === 'verify-applied') {
    if (args.length !== 1) throw new Error(USAGE);
    assertReleaseApplied(read(args[0]));
    console.log(`Verified: remote history has the baseline and stages ${allStages} applied, nothing pending.`);
  } else {
    throw new Error(USAGE);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (command === 'plan') console.error('Deployment stopped before any database change.');
  process.exit(1);
}
