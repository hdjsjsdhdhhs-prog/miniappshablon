// Usage:
//   tsx scripts/check-migration-integrity.ts
//     → verifies every reviewed migration in this repository's supabase/migrations (resolved from this script, not
//       from the working directory) against the approved SHA-256 in scripts/lib/migration-integrity-manifest.ts;
//       exits non-zero on any missing, extra, renamed or changed file.
//   tsx scripts/check-migration-integrity.ts hash <file.sql>...
//     → prints the canonical SHA-256 of the given files, for a reviewer who adds or updates a manifest entry by hand.
//       Only prints: the manifest is never written by any tool.
import { readFileSync } from 'node:fs';
import { APPLIED_BASELINE_MIGRATION_FILES, MIGRATION_STAGES } from './lib/migration-plan.ts';
import { assertMigrationIntegrity, canonicalSha256, DEFAULT_MIGRATIONS_DIR } from './lib/migration-integrity.ts';

const USAGE = 'Usage: check-migration-integrity.ts | check-migration-integrity.ts hash <file.sql>...';
const [command, ...args] = process.argv.slice(2);

try {
  if (command === undefined) {
    const verified = assertMigrationIntegrity();
    for (const { file, sha256 } of verified) console.log(`OK  ${sha256}  ${file}`);
    const stages = MIGRATION_STAGES.map((s) => `${s.id} ${s.files.length}`).join(', ');
    console.log(
      `Migration integrity: all ${verified.length} reviewed migration file(s) in ${DEFAULT_MIGRATIONS_DIR} match the approved SHA-256 ` +
        `(baseline ${APPLIED_BASELINE_MIGRATION_FILES.length}, ${stages}).`,
    );
  } else if (command === 'hash') {
    if (args.length === 0) throw new Error(USAGE);
    for (const file of args) console.log(`${canonicalSha256(readFileSync(file), file)}  ${file}`);
  } else {
    throw new Error(USAGE);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
