/**
 * Controlled production release (`.github/workflows/release.yml`): the rules of the preflight, as pure functions.
 * The CLI that feeds them with GitHub API data is scripts/release-preflight.ts; the tests are release.test.ts.
 *
 * Release SHA policy (documented in RELEASE.md): the operator types the full SHA of the commit to release and starts
 * the workflow from `main`. The SHA must be exactly the commit the run was started for (`github.sha`, i.e. the main
 * HEAD at dispatch time) — never a "nearby" or abbreviated commit — and it must still be in the history of `main`
 * when the preflight runs (assertCommitOnMain). If main only moved forward in between, the run releases the typed
 * commit (still an ancestor of main), never the newer one; if the commit is no longer in main's history (history
 * rewritten), the preflight stops.
 *
 * Nothing here reads secrets: the preflight runs before any environment approval, with a read-only GITHUB_TOKEN.
 */

export const RELEASE_REF = 'refs/heads/main';
export const RELEASE_BRANCH = 'main';

/** The three CI checks the `protect-main` ruleset requires; the release needs all of them green on the SHA. */
export const REQUIRED_CI_CHECKS = [
  'Lint · types · unit · build',
  'Edge Functions · deno check',
  'SQL/integration + Playwright (local Supabase in Docker)',
] as const;

/** GitHub Actions app id (the `integration_id` the ruleset pins the required checks to). */
export const GITHUB_ACTIONS_APP_ID = 15368;
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/**
 * Migration stages this pipeline may apply. Expand stages only: a Contract stage (3C) must never be applied
 * automatically by a release — if the reviewed manifest (scripts/lib/migration-plan.ts) gains any other stage, the
 * preflight stops before production is touched, and the Supabase job re-checks the planned stages before `db push`.
 */
export const RELEASE_ALLOWED_STAGES: readonly string[] = ['3A', '3B'];

/** Deployment environments of the release, each of which must exist and be protected before anything runs. */
export const RELEASE_ENVIRONMENTS = ['production', 'production-frontend'] as const;

/**
 * The only Supabase project a release may target (not a secret). Every configured identifier is checked against it:
 * vars.SUPABASE_PROJECT_REF before `supabase link`, vars.VITE_SUPABASE_URL before the frontend build and before every
 * smoke request; the Session Pooler step of supabase-deploy.yml pins the same value (kept equal by workflows.test.ts).
 */
export const PRODUCTION_SUPABASE_PROJECT_REF = 'xcbugcjmddtubytpvffa';

function fail(reason: string): never {
  throw new Error(`Release preflight: ${reason}`);
}

/** Supabase project refs are 20 lowercase letters. */
const PROJECT_REF = /^[a-z]{20}$/;

/**
 * A configured project ref must be exactly the approved one. Fail-closed on a missing, malformed or different value;
 * the configured value itself is never printed.
 */
export function assertProjectRef(ref: string | undefined, approved: string = PRODUCTION_SUPABASE_PROJECT_REF): string {
  if (!PROJECT_REF.test(approved)) fail('the approved Supabase project ref is not a valid project ref');
  if (ref === undefined || ref === '') fail('Supabase project ref is not set');
  if (!PROJECT_REF.test(ref)) fail('Supabase project ref is malformed (expected 20 lowercase letters)');
  if (ref !== approved) fail(`Supabase project ref does not match the approved production project ${approved}`);
  return ref;
}

/**
 * The Supabase URL must be exactly `https://<expectedRef>.supabase.co` (an optional trailing `/` is accepted):
 * HTTPS, that exact host, no userinfo, no port (not even an explicit :443), no path, query or fragment, no whitespace.
 * `expectedRef` must itself be the approved project ref. Returns the canonical origin. Errors never contain the
 * configured URL (it could carry credentials), only the expected origin.
 */
export function assertSupabaseProjectUrl(raw: string | undefined, expectedRef: string = PRODUCTION_SUPABASE_PROJECT_REF): string {
  assertProjectRef(expectedRef);
  const origin = `https://${expectedRef}.supabase.co`;
  const wrong = (reason: string): never => fail(`Supabase URL ${reason}; it must be exactly ${origin}`);
  if (raw === undefined || raw === '') return wrong('is not set');
  if (/\s/.test(raw)) return wrong('contains whitespace');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return wrong('is malformed');
  }
  if (url.protocol !== 'https:') return wrong('does not use https');
  if (url.username !== '' || url.password !== '') return wrong('must not contain credentials');
  if (url.hostname !== `${expectedRef}.supabase.co`) return wrong('does not point to the approved project host');
  // The parser normalises `:443`, an empty `?`/`#`, upper-case hosts and dot segments away: compare the raw text too.
  if (raw !== origin && raw !== `${origin}/`) return wrong('has an unexpected port, path, query or fragment');
  return origin;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export function assertReleaseRef(ref: string | undefined, eventName: string | undefined): void {
  if (eventName !== 'workflow_dispatch') fail(`must be started manually (workflow_dispatch), not by "${eventName ?? ''}"`);
  if (ref !== RELEASE_REF) fail(`must be started from ${RELEASE_REF}, not from "${ref ?? ''}"`);
}

/** The typed SHA: full lowercase 40-hex, and exactly the commit this run was started for. */
export function assertReleaseSha(input: string | undefined, runSha: string | undefined): string {
  const sha = (input ?? '').trim();
  if (!FULL_SHA.test(sha)) fail('input "sha" must be the full 40-character lowercase commit SHA');
  if (!runSha || !FULL_SHA.test(runSha)) fail('the run SHA (GITHUB_SHA) is missing');
  if (sha !== runSha) {
    fail(`input sha ${sha} is not the commit this run was started for (${runSha}); start the release from main at that commit`);
  }
  return sha;
}

/** `backup_verified` must be exactly true and `backup_reference` a single printable line. */
export function assertBackupConfirmation(verified: string | undefined, reference: string | undefined): string {
  if (verified !== 'true') fail('backup_verified must be true: take and verify a production backup before releasing');
  const ref = (reference ?? '').trim();
  if (ref.length < 3) fail('backup_reference is empty: enter the identifier of the verified backup');
  if (ref.length > 200) fail('backup_reference is longer than 200 characters');
  // One printable line: no control characters (newlines could forge log lines / workflow commands).
  if (/\p{Cc}/u.test(ref)) fail('backup_reference must be a single line without control characters');
  return ref;
}

/** The fields of `GET /repos/{owner}/{repo}/compare/{base}...{head}` the preflight relies on (untrusted: unknown). */
export interface CompareResult {
  status?: unknown;
  ahead_by?: unknown;
  behind_by?: unknown;
}

/**
 * GitHub compare `<sha>...main` — base = the release SHA, head = the current main. `status`, `ahead_by` and
 * `behind_by` describe HEAD (main) relative to BASE (the SHA):
 *   identical — main is the SHA;                          ahead    — main has newer commits on top of the SHA;
 *   behind    — main is an ancestor of the SHA (lacks it); diverged — both have commits the other lacks.
 * The SHA is in the history of main exactly when main lacks none of its commits: status `identical` or `ahead` AND
 * `behind_by === 0`. Everything else — behind, diverged, no response (404 → null), a malformed body, a missing or
 * non-integer `behind_by` — fails closed.
 */
export function assertCommitOnMain(compare: CompareResult | null | undefined): void {
  if (!compare || typeof compare !== 'object') fail(`commit is not in the history of ${RELEASE_BRANCH} (no compare result)`);
  const { status, behind_by: behindBy } = compare;
  if (typeof behindBy !== 'number' || !Number.isInteger(behindBy) || behindBy < 0) {
    fail(`commit is not in the history of ${RELEASE_BRANCH} (malformed compare result: behind_by ${JSON.stringify(behindBy) ?? 'missing'})`);
  }
  if ((status !== 'identical' && status !== 'ahead') || behindBy !== 0) {
    fail(`commit is not in the history of ${RELEASE_BRANCH} (compare status "${String(status ?? '')}", behind_by ${behindBy})`);
  }
}

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app?: { id?: number | null; slug?: string | null } | null;
}

/** Every required check: produced by GitHub Actions for this SHA, the latest run of it completed with success. */
export function assertRequiredChecks(runs: readonly CheckRun[], sha: string): void {
  const problems: string[] = [];
  for (const name of REQUIRED_CI_CHECKS) {
    const candidates = runs.filter((r) => r.name === name && r.head_sha === sha && r.app?.id === GITHUB_ACTIONS_APP_ID);
    if (candidates.length === 0) {
      problems.push(`"${name}": no GitHub Actions check run for ${sha}`);
      continue;
    }
    const latest = candidates.reduce((a, b) => (b.id > a.id ? b : a));
    if (latest.status !== 'completed' || latest.conclusion !== 'success') {
      problems.push(`"${name}": ${latest.status}/${latest.conclusion ?? 'none'}`);
    }
  }
  if (problems.length > 0) fail(`required CI checks are not green: ${problems.join('; ')}`);
}

export interface WorkflowRun {
  id: number;
  path: string;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
}

/** The CI workflow ran for this SHA on a push to main, and its latest such run succeeded. */
export function assertCiWorkflowRun(runs: readonly WorkflowRun[], sha: string): void {
  const own = runs.filter(
    (r) => r.path === CI_WORKFLOW_PATH && r.head_sha === sha && r.event === 'push' && r.head_branch === RELEASE_BRANCH,
  );
  if (own.length === 0) fail(`no CI run (${CI_WORKFLOW_PATH}, push to ${RELEASE_BRANCH}) for ${sha}`);
  const latest = own.reduce((a, b) => (b.id > a.id ? b : a));
  if (latest.status !== 'completed' || latest.conclusion !== 'success') {
    fail(`latest CI run ${latest.id} for ${sha} is ${latest.status ?? 'unknown'}/${latest.conclusion ?? 'none'}`);
  }
}

/** Stage ids (from the manifest, or the gate's planned `stages` output) must all be allowed for a release. */
export function assertAllowedStages(stageIds: readonly string[], allowed: readonly string[] = RELEASE_ALLOWED_STAGES): void {
  const extra = stageIds.filter((s) => !allowed.includes(s));
  if (extra.length > 0) {
    fail(`migration stage(s) ${extra.join(', ')} are not allowed in a release (allowed: ${allowed.join(', ')}); Contract stages are applied only by a separate, reviewed change`);
  }
}

/** `3A,3B` → ['3A', '3B']; '' → []. Rejects anything that is not a plain comma-separated list of stage ids. */
export function parseStageList(csv: string | undefined): string[] {
  const raw = (csv ?? '').trim();
  if (raw === '') return [];
  const ids = raw.split(',');
  for (const id of ids) if (!/^[0-9][A-Z]$/.test(id)) fail(`invalid stage list "${raw}"`);
  return ids;
}

export interface Environment {
  name: string;
  can_admins_bypass?: boolean;
  protection_rules?: Array<{ type: string; reviewers?: unknown[] }>;
  deployment_branch_policy?: { protected_branches: boolean; custom_branch_policies: boolean } | null;
}
export interface BranchPolicy {
  name: string;
  type?: string;
}

/**
 * A deployment environment is safe for the release only when it already exists (GitHub would otherwise create it,
 * unprotected, the moment a job references it), requires a reviewer, cannot be bypassed by admins, and deploys only
 * from main (custom branch policy = exactly the branch `main`).
 */
export function assertEnvironmentProtected(name: string, env: Environment | null, policies: readonly BranchPolicy[] | null): void {
  if (!env) fail(`environment "${name}" does not exist; the owner must create and protect it before any release (it is never created by this workflow)`);
  const problems: string[] = [];
  if (env.name !== name) problems.push(`API returned environment "${env.name}"`);
  const reviewers = (env.protection_rules ?? []).find((r) => r.type === 'required_reviewers');
  if (!reviewers || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length === 0) problems.push('no required reviewer');
  if (env.can_admins_bypass !== false) problems.push('administrators can bypass the protection rules');
  const policy = env.deployment_branch_policy;
  if (!policy || policy.custom_branch_policies !== true || policy.protected_branches !== false) {
    problems.push('deployment branches are not limited to selected branches');
  } else {
    const list = policies ?? [];
    const onlyMain = list.length === 1 && list[0]!.name === RELEASE_BRANCH && (list[0]!.type ?? 'branch') === 'branch';
    if (!onlyMain) problems.push(`deployment branch policy must be exactly [${RELEASE_BRANCH}], is [${list.map((p) => `${p.type ?? 'branch'}:${p.name}`).join(', ')}]`);
  }
  if (problems.length > 0) fail(`environment "${name}" is not protected: ${problems.join('; ')}`);
}
