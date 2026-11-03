// Preflight of .github/workflows/release.yml (rules: scripts/lib/release.ts). Runs on GitHub Actions only, BEFORE any
// environment approval: it never sees a production secret, only the run's read-only GITHUB_TOKEN.
//
// Usage:
//   tsx scripts/release-preflight.ts preflight
//     env: GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN, RELEASE_SHA, BACKUP_REFERENCE,
//          BACKUP_VERIFIED. Checks ref, SHA, backup confirmation, SHA in main, CI run + the three required checks green,
//          the migration manifest has only release-allowed stages, both deployment environments exist and are protected.
//   tsx scripts/release-preflight.ts environments
//     → only the environment protection check (re-run right before the frontend job).
//   tsx scripts/release-preflight.ts stages <planned-stages>
//     → the migration gate's planned stages (`3A,3B`, `3B` or empty) must all be release-allowed (no Contract stage).
//   tsx scripts/release-preflight.ts project-ref
//     env: SUPABASE_PROJECT_REF → must be exactly PRODUCTION_SUPABASE_PROJECT_REF (before `supabase link`).
//   tsx scripts/release-preflight.ts supabase-url
//     env: SUPABASE_URL → must be exactly https://<PRODUCTION_SUPABASE_PROJECT_REF>.supabase.co (before the build).
import { MIGRATION_STAGES } from './lib/migration-plan.ts';
import {
  assertAllowedStages,
  assertBackupConfirmation,
  assertCiWorkflowRun,
  assertCommitOnMain,
  assertEnvironmentProtected,
  assertProjectRef,
  assertReleaseRef,
  assertReleaseSha,
  assertRequiredChecks,
  assertSupabaseProjectUrl,
  parseStageList,
  PRODUCTION_SUPABASE_PROJECT_REF,
  RELEASE_BRANCH,
  RELEASE_ENVIRONMENTS,
  REQUIRED_CI_CHECKS,
  type BranchPolicy,
  type CheckRun,
  type CompareResult,
  type Environment,
  type WorkflowRun,
} from './lib/release.ts';

const USAGE = 'Usage: release-preflight.ts preflight | environments | stages <planned-stages> | project-ref | supabase-url';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Release preflight: environment variable ${name} is not set`);
  return value;
}

/** GET from the GitHub REST API of this repository. Returns null on 404; any other error stops the preflight. */
async function gh<T>(path: string): Promise<T | null> {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const res = await fetch(`${api}/repos/${env('GITHUB_REPOSITORY')}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Release preflight: GitHub API ${path.split('?')[0]} answered ${res.status}`);
  return (await res.json()) as T;
}

async function checkEnvironments(): Promise<void> {
  for (const name of RELEASE_ENVIRONMENTS) {
    const environment = await gh<Environment>(`/environments/${name}`);
    const policies = environment
      ? ((await gh<{ branch_policies: BranchPolicy[] }>(`/environments/${name}/deployment-branch-policies?per_page=100`))?.branch_policies ?? [])
      : null;
    assertEnvironmentProtected(name, environment, policies);
    console.log(`OK  environment ${name}: exists, required reviewer, no admin bypass, deploys from ${RELEASE_BRANCH} only`);
  }
}

async function preflight(): Promise<void> {
  assertReleaseRef(process.env.GITHUB_REF, process.env.GITHUB_EVENT_NAME);
  console.log(`OK  started manually from ${process.env.GITHUB_REF}`);
  const sha = assertReleaseSha(process.env.RELEASE_SHA, process.env.GITHUB_SHA);
  console.log(`OK  release SHA ${sha} = the commit this run was started for`);
  const backup = assertBackupConfirmation(process.env.BACKUP_VERIFIED, process.env.BACKUP_REFERENCE);
  // An operator attestation only: nothing here proves that the backup exists, is intact or can be restored (RELEASE.md,
  // "Backup" — open blocker until an automated, verified backup step exists).
  console.log(`ATTESTED  backup reference given by the operator, NOT verified by this pipeline: ${backup}`);

  // base = the release SHA, head = main; the whole response is judged (status AND behind_by), not only the status.
  const compare = await gh<CompareResult>(`/compare/${sha}...${RELEASE_BRANCH}`);
  assertCommitOnMain(compare);
  console.log(`OK  ${sha} is in the history of ${RELEASE_BRANCH} (${compare?.status})`);

  const runs = await gh<{ workflow_runs: WorkflowRun[] }>(`/actions/runs?head_sha=${sha}&event=push&branch=${RELEASE_BRANCH}&per_page=100`);
  assertCiWorkflowRun(runs?.workflow_runs ?? [], sha);
  console.log(`OK  CI workflow run for ${sha} (push to ${RELEASE_BRANCH}) succeeded`);

  const checks = await gh<{ check_runs: CheckRun[] }>(`/commits/${sha}/check-runs?filter=latest&per_page=100`);
  assertRequiredChecks(checks?.check_runs ?? [], sha);
  for (const name of REQUIRED_CI_CHECKS) console.log(`OK  required check "${name}" succeeded`);

  assertAllowedStages(MIGRATION_STAGES.map((s) => s.id));
  console.log(`OK  migration manifest stages ${MIGRATION_STAGES.map((s) => s.id).join(', ')} are all release-allowed (no Contract stage)`);

  await checkEnvironments();
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'preflight' && args.length === 0) await preflight();
  else if (command === 'environments' && args.length === 0) await checkEnvironments();
  else if (command === 'stages' && args.length <= 1) {
    const planned = parseStageList(args[0]);
    assertAllowedStages(planned);
    console.log(`OK  planned migration stages [${planned.join(', ')}] are all release-allowed`);
  } else if (command === 'project-ref' && args.length === 0) {
    assertProjectRef(process.env.SUPABASE_PROJECT_REF);
    console.log(`OK  SUPABASE_PROJECT_REF is the approved production project ${PRODUCTION_SUPABASE_PROJECT_REF}`);
  } else if (command === 'supabase-url' && args.length === 0) {
    const origin = assertSupabaseProjectUrl(process.env.SUPABASE_URL, PRODUCTION_SUPABASE_PROJECT_REF);
    console.log(`OK  Supabase URL is the approved production project ${origin}`);
  } else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error('Release stopped: nothing was deployed by this step.');
  process.exit(1);
}
