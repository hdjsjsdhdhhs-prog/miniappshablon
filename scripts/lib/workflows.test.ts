// Invariants of the GitHub Actions workflows that protect production. The workflows are checked as text: the
// assertions are on exact commands and their order, so a reordering or a removed re-check fails here. YAML syntax and
// expressions are validated separately with actionlint.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DENO_VERSION, REPO_ROOT } from './edge-functions';
import { PRODUCTION_SUPABASE_PROJECT_REF } from './release';

const read = (file: string) => readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8').replace(/\r\n/g, '\n');

/** Content lines of a top-level YAML key (`key:` at column 0) up to the next top-level key; comments / blanks dropped. */
function topLevelBlock(yaml: string, key: string): string | null {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^[A-Za-z_]/.test(l));
  const content = lines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  return `${content.join('\n')}\n`;
}

/** Lines of a job (`  <name>:` under `jobs:`) up to the next job. */
function jobBlock(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`  ${name}:`, lines.indexOf('jobs:'));
  if (start < 0) throw new Error(`job ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** Index of each needle, searched in order (each after the previous one); -1 when missing or out of order. */
function inOrder(text: string, needles: string[]): number[] {
  let from = 0;
  return needles.map((n) => {
    const i = text.indexOf(n, from);
    if (i >= 0) from = i + n.length;
    return i;
  });
}

/** Job names under `jobs:` (2-space indented keys), in file order. */
function jobNames(yaml: string): string[] {
  const lines = yaml.split('\n');
  return lines
    .slice(lines.indexOf('jobs:') + 1)
    .map((l) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
}

/** Steps of a job (each `      - ` item under `steps:`), with a label: its `name:`, otherwise its first line. */
function stepsOf(job: string): Array<{ label: string; text: string }> {
  const lines = job.split('\n');
  const start = lines.indexOf('    steps:');
  if (start < 0) return [];
  const steps: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('      - ')) steps.push([line]);
    else if (steps.length > 0) steps[steps.length - 1]!.push(line);
  }
  return steps.map((s) => {
    const text = s.join('\n');
    const name = /^ {6}(?:- | {2})name: (.+)$/m.exec(text)?.[1];
    return { label: name ?? s[0]!.trim(), text };
  });
}

/** Secret names referenced in a piece of workflow text (`secrets.X`), sorted, unique. */
const secretsIn = (text: string) => [...new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!))].sort();

/**
 * Problems of one `uses:` value. Local reusable workflows / actions (`./…`) are fine; every other action must be
 * `owner/repo[/path]@<40-hex commit SHA> # v<semver>` — never a tag, branch or short SHA; docker:// only by digest.
 */
function unpinnedReason(uses: string): string | null {
  if (uses.startsWith('./')) return null;
  if (uses.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(uses) ? null : 'docker image not pinned by digest';
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@(\S+)(.*)$/.exec(uses);
  if (!m) return 'not owner/repo@ref';
  if (!/^[0-9a-f]{40}$/.test(m[2]!)) return `ref "${m[2]}" is not a full 40-character commit SHA`;
  if (!/^ # v\d+\.\d+\.\d+$/.test(m[3]!)) return 'missing "# vX.Y.Z" version comment';
  return null;
}

/** The `needs:` list of a job ([] when it has none). */
function needsOf(job: string): string[] {
  const m = /^ {4}needs: \[([^\]]*)\]$/m.exec(job);
  return m ? m[1]!.split(',').map((s) => s.trim()) : [];
}

describe('supabase-deploy.yml', () => {
  const yaml = read('supabase-deploy.yml');

  it('is a reusable workflow only: no trigger of its own, so it cannot be dispatched around the release preflight', () => {
    expect(topLevelBlock(yaml, 'on')).toBe(
      'on:\n  workflow_call:\n    inputs:\n      sha:\n' +
        '        description: Full SHA validated by the release preflight; the exact commit that is checked out and deployed.\n' +
        '        required: true\n        type: string\n',
    );
    expect(yaml).not.toMatch(/^\s*(workflow_dispatch|push|pull_request|pull_request_target|schedule|repository_dispatch|workflow_run):/m);
  });

  it('has no concurrency of its own: the caller (release.yml) holds the single production-release group', () => {
    expect(yaml).not.toMatch(/^\s*concurrency:/m);
  });

  it('runs only on main, in the production environment, with a read-only token', () => {
    expect(topLevelBlock(yaml, 'permissions')).toBe('permissions:\n  contents: read\n');
    expect(jobNames(yaml)).toEqual(['deploy']);
    expect(jobBlock(yaml, 'deploy')).toContain("    if: github.ref == 'refs/heads/main'\n    environment: production\n");
  });

  it('refuses any caller but release.yml on main before checkout, and deploys exactly the given SHA', () => {
    const order = inOrder(jobBlock(yaml, 'deploy'), [
      "- name: Guard — called by release.yml on main for the run's SHA",
      'EXPECTED_CALLER: ${{ github.repository }}/.github/workflows/release.yml@refs/heads/main',
      'if [ "$GITHUB_REF" != "refs/heads/main" ]',
      'if [ "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]',
      'if [ "$GITHUB_WORKFLOW_REF" != "$EXPECTED_CALLER" ]',
      '=~ ^[0-9a-f]{40}$',
      'if [ "$RELEASE_SHA" != "$GITHUB_SHA" ]',
      'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          ref: ${{ inputs.sha }}\n          persist-credentials: false',
      'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
      'run: pnpm check:migration-integrity',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
  });

  it('applies only release-allowed (Expand) stages: the planned stages are checked between plan and db push', () => {
    const order = inOrder(yaml, [
      '- name: Validate migration plan',
      '- name: Planned stages are release-allowed (no Contract stage)',
      'PLANNED_STAGES: ${{ steps.plan.outputs.stages }}',
      'run: pnpm exec tsx scripts/release-preflight.ts stages "$PLANNED_STAGES"',
      '- name: Apply migrations',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
  });

  it('keeps the migration gate order: integrity → link → plan → re-check → db push → verify → functions', () => {
    const order = inOrder(yaml, [
      'run: pnpm check:migration-integrity', // before anything touches the database
      'supabase link --project-ref',
      'Validate Session Pooler target',
      '--output-format json \\\n            > "$RUNNER_TEMP/migration-list.json"',
      'db push --dry-run --db-url "$SUPABASE_DB_URL" --agent no --output-format json',
      'check-production-migration-plan.ts plan "$RUNNER_TEMP/migration-list.json" "$RUNNER_TEMP/db-push-dry-run.json"',
      "if: steps.plan.outputs.mode == 'apply'",
      'pnpm check:migration-integrity\n', // re-hash right before the push
      '> "$RUNNER_TEMP/migration-list-recheck.json"',
      '> "$RUNNER_TEMP/db-push-dry-run-recheck.json"',
      '--expect-stages "$PLANNED_STAGES"',
      'pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"\n',
      'check-production-migration-plan.ts verify-applied',
      'supabase functions deploy checkout',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
  });

  it('has exactly one real db push, inside the guarded apply step, without bypass flags', () => {
    const pushes = [...yaml.matchAll(/supabase db push(?! --dry-run)/g)];
    expect(pushes).toHaveLength(1);
    const apply = yaml.slice(yaml.indexOf('- name: Apply migrations'), yaml.indexOf('- name: Verify migration history after push'));
    expect(apply).toContain("if: steps.plan.outputs.mode == 'apply'");
    expect(apply).toContain('PLANNED_STAGES: ${{ steps.plan.outputs.stages }}');
    expect(apply).toMatch(/supabase db push --db-url "\$SUPABASE_DB_URL"\n/);
    for (const flag of ['--include-all', '--workdir', 'continue-on-error', '|| true', 'SUPABASE_WORKDIR']) expect(yaml).not.toContain(flag);
  });
});

describe('ci.yml', () => {
  const yaml = read('ci.yml');

  it('keeps its own per-ref concurrency group, separate from production releases', () => {
    expect(topLevelBlock(yaml, 'concurrency')).toBe('concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n');
    expect(yaml).not.toContain('supabase-deploy-production');
    expect(yaml).not.toContain('production-release');
  });

  it('keeps the existing quality checks', () => {
    const quality = jobBlock(yaml, 'quality');
    for (const cmd of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm check:tenant-names', 'pnpm check:migration-integrity', 'pnpm build', 'pnpm check:bundle-secrets']) {
      expect(quality).toContain(`run: ${cmd}`);
    }
  });

  it('type-checks the Edge Functions with the pinned Deno and leaves the tree unchanged', () => {
    const job = jobBlock(yaml, 'edge-functions-deno-check');
    expect(job).toMatch(/uses: denoland\/setup-deno@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(job).toContain(`deno-version: ${DENO_VERSION}\n`);
    expect(inOrder(job, ['pnpm install --frozen-lockfile', 'denoland/setup-deno@', 'run: pnpm check:edge-functions', 'git diff --exit-code']).every((i) => i >= 0)).toBe(true);
    expect(job).not.toContain('continue-on-error');
  });

  it('keeps the SQL/integration and Playwright checks on the local stack', () => {
    const job = jobBlock(yaml, 'integration');
    for (const cmd of ['pnpm db:start', 'supabase db diff --local', 'tenant:verify', 'pnpm test:integration', 'pnpm test:e2e']) expect(job).toContain(cmd);
  });

  it('keeps the three required check names (protect-main ruleset)', () => {
    expect(jobBlock(yaml, 'quality')).toContain('    name: Lint · types · unit · build\n');
    expect(jobBlock(yaml, 'edge-functions-deno-check')).toContain('    name: Edge Functions · deno check\n');
    expect(jobBlock(yaml, 'integration')).toContain('    name: SQL/integration + Playwright (local Supabase in Docker)\n');
  });

  it('only verifies code: no Cloudflare deploy job, no environment, no secret, read-only token', () => {
    expect(jobNames(yaml)).toEqual(['quality', 'edge-functions-deno-check', 'integration']);
    expect(yaml).not.toContain('deploy-cloudflare-pages');
    for (const banned of ['environment:', 'secrets.', 'wrangler', 'pages deploy', 'supabase db push', 'functions deploy', 'CLOUDFLARE_']) {
      expect(yaml, banned).not.toContain(banned);
    }
    expect(topLevelBlock(yaml, 'permissions')).toBe('permissions:\n  contents: read\n');
    expect(yaml).not.toMatch(/^ {4}permissions:/m);
  });
});

describe('release.yml', () => {
  const yaml = read('release.yml');
  const job = (name: string) => jobBlock(yaml, name);

  it('is started manually only, with the SHA and the backup confirmation as required inputs', () => {
    const on = topLevelBlock(yaml, 'on')!;
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(['  workflow_dispatch:']);
    for (const input of ['sha', 'backup_reference', 'backup_verified']) {
      expect(on).toMatch(new RegExp(`\\n {6}${input}:\\n(?: {8}.*\\n)*? {8}required: true\\n`));
    }
    expect(on).toMatch(/ {6}backup_verified:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: false\n/);
  });

  it('has the pipeline preflight → supabase → smoke-api → frontend → smoke-web with explicit needs', () => {
    expect(jobNames(yaml)).toEqual(['preflight', 'supabase', 'smoke-api', 'frontend', 'smoke-web']);
    expect(needsOf(job('preflight'))).toEqual([]);
    expect(needsOf(job('supabase'))).toEqual(['preflight']);
    expect(needsOf(job('smoke-api'))).toEqual(['preflight', 'supabase']);
    expect(needsOf(job('frontend'))).toEqual(['preflight', 'smoke-api']);
    expect(needsOf(job('smoke-web'))).toEqual(['preflight', 'frontend']);
  });

  it('blocks the frontend unless smoke-api succeeded (no always()/failure()/continue-on-error anywhere)', () => {
    // needs + an `if` without a status function → GitHub adds success(): a failed or skipped smoke-api skips frontend.
    expect(job('frontend')).toContain("    if: github.ref == 'refs/heads/main'\n");
    for (const bypass of ['always()', 'failure()', 'cancelled()', 'continue-on-error', '|| true']) expect(yaml, bypass).not.toContain(bypass);
  });

  it('serialises releases in one fixed concurrency group and never cancels a running release', () => {
    const block = topLevelBlock(yaml, 'concurrency');
    expect(block).toBe('concurrency:\n  group: production-release\n  cancel-in-progress: false\n');
    expect(block).not.toContain('${{');
    expect(yaml.match(/^\s*concurrency:/gm)).toHaveLength(1);
  });

  it('starts with no token permissions and grants each job only what it needs', () => {
    expect(topLevelBlock(yaml, 'permissions')).toBe('permissions: {}\n');
    const perms = (name: string) => /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(`${job(name)}\n`)?.[1]?.replace(/ *#.*$/gm, '');
    expect(perms('preflight')).toBe('      contents: read\n      actions: read\n      checks: read\n');
    expect(perms('supabase')).toBe('      contents: read\n');
    expect(perms('smoke-api')).toBe('      contents: read\n      actions: read\n');
    expect(perms('frontend')).toBe('      contents: read\n');
    expect(perms('smoke-web')).toBe('      contents: read\n');
    expect(yaml).not.toMatch(/: write\b/);
  });

  it('preflight guards main and the full SHA of the run, then runs the API preflight and the integrity check', () => {
    const order = inOrder(job('preflight'), [
      'RELEASE_SHA: ${{ inputs.sha }}',
      'if [ "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]',
      'if [ "$GITHUB_REF" != "refs/heads/main" ]',
      '=~ ^[0-9a-f]{40}$',
      'if [ "$RELEASE_SHA" != "$GITHUB_SHA" ]',
      'echo "sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"',
      'ref: ${{ steps.guard.outputs.sha }}',
      'BACKUP_REFERENCE: ${{ inputs.backup_reference }}',
      'BACKUP_VERIFIED: ${{ inputs.backup_verified }}',
      'run: pnpm exec tsx scripts/release-preflight.ts preflight',
      'run: pnpm check:migration-integrity',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    // Inputs reach scripts only through env (`KEY: ${{ inputs.x }}`), never interpolated into a command.
    for (const line of yaml.split('\n').filter((l) => l.includes('inputs.'))) {
      expect(line, line).toMatch(/^ +[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$|^ +(?:description|ref|sha): /);
    }
  });

  it('preflight never sees a production secret or variable and has no environment', () => {
    const pre = job('preflight');
    for (const banned of ['environment:', 'secrets.', 'vars.']) expect(pre, banned).not.toContain(banned);
  });

  it('deploys Supabase only through the reusable supabase-deploy.yml, on main, for the preflight SHA', () => {
    const sup = job('supabase');
    expect(sup).toContain('    uses: ./.github/workflows/supabase-deploy.yml\n    with:\n      sha: ${{ needs.preflight.outputs.sha }}');
    expect(sup).toContain("    if: github.ref == 'refs/heads/main'\n");
    expect(sup).not.toContain('secrets: inherit');
    // No second, direct Supabase deployment path in the release.
    expect(yaml).not.toMatch(/supabase (db push|functions deploy|link)/);
  });

  it('has an environment on every deploying job: production (Supabase, called workflow) and production-frontend', () => {
    expect(read('supabase-deploy.yml')).toContain('    environment: production\n');
    expect(job('frontend')).toContain('    environment: production-frontend\n');
    for (const name of ['preflight', 'smoke-api', 'smoke-web']) expect(job(name)).not.toContain('environment:');
    expect(yaml.match(/^ {4}environment:/gm)).toHaveLength(1);
    // Secrets are used only by the frontend job (Cloudflare); everything else is public or the run's token.
    for (const name of ['preflight', 'supabase', 'smoke-api', 'smoke-web']) expect(job(name)).not.toContain('secrets.');
  });

  it('smoke-api runs the read-only API checks and re-checks the environments right before the frontend', () => {
    const order = inOrder(job('smoke-api'), [
      'ref: ${{ needs.preflight.outputs.sha }}',
      'SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}',
      'SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}',
      'run: pnpm exec tsx scripts/release-smoke.ts api',
      'run: pnpm exec tsx scripts/release-preflight.ts environments',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
  });

  it('frontend builds the exact SHA, checks the bundle, and deploys with the production-frontend Cloudflare names', () => {
    const order = inOrder(job('frontend'), [
      'if [ "$GITHUB_REF" != "refs/heads/main" ]',
      'ref: ${{ needs.preflight.outputs.sha }}\n          persist-credentials: false',
      'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
      'pnpm install --frozen-lockfile',
      'VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}',
      'VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}',
      'pnpm build',
      'run: pnpm check:bundle-secrets',
      'uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3.15.0',
      'apiToken: ${{ secrets.PRODUCTION_CLOUDFLARE_API_TOKEN }}',
      'accountId: ${{ secrets.PRODUCTION_CLOUDFLARE_ACCOUNT_ID }}',
      'command: pages deploy dist --project-name=${{ vars.PRODUCTION_CLOUDFLARE_PAGES_PROJECT }} --branch=main --commit-hash=${{ needs.preflight.outputs.sha }}',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect(yaml.match(/pages deploy/g)).toHaveLength(1);
  });

  it('smoke-web checks the deployment URL and the production address after the frontend deploy', () => {
    const web = job('smoke-web');
    expect(web).toContain('DEPLOYMENT_URL: ${{ needs.frontend.outputs.deployment_url }}');
    expect(web).toContain('PAGES_PROJECT: ${{ needs.frontend.outputs.pages_project }}');
    // Named, required arguments: an empty DEPLOYMENT_URL reaches the CLI as an empty value and fails there.
    expect(web).toContain(
      'run: pnpm exec tsx scripts/release-smoke.ts web --deployment-url "$DEPLOYMENT_URL" --production-url "$PRODUCTION_APP_URL" --pages-project "$PAGES_PROJECT"\n',
    );
    expect(web.match(/release-smoke\.ts web/g)).toHaveLength(1);
    expect(job('frontend')).toContain('deployment_url: ${{ steps.deploy.outputs.deployment-url }}');
  });

  it('the smoke CLI no longer drops empty targets', () => {
    const smoke = readFileSync(join(REPO_ROOT, 'scripts', 'release-smoke.ts'), 'utf8');
    expect(smoke).not.toMatch(/\.filter\(\(u\) => u\.trim\(\) !== ''\)/);
    expect(smoke).toContain('parseWebArgs(rest)');
  });
});

describe('no deployment outside release.yml', () => {
  const files = readdirSync(join(REPO_ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();

  it('the workflows are exactly ci, release and the reusable supabase-deploy', () => {
    expect(files).toEqual(['ci.yml', 'release.yml', 'supabase-deploy.yml']);
  });

  it('nothing deploys on pull_request or push: only ci.yml has those triggers, and it deploys nothing', () => {
    for (const f of ['release.yml', 'supabase-deploy.yml']) {
      expect(topLevelBlock(read(f), 'on'), f).not.toMatch(/pull_request|push:|schedule|workflow_run/);
    }
    expect(topLevelBlock(read('ci.yml'), 'on')).toBe('on:\n  push:\n    branches: [main]\n  pull_request:\n');
  });

  it('only release.yml calls a reusable workflow or Cloudflare', () => {
    for (const f of files.filter((x) => x !== 'release.yml')) {
      const yaml = read(f);
      expect(yaml, f).not.toMatch(/uses: \.\/\.github\/workflows\//);
      expect(yaml, f).not.toContain('wrangler');
    }
  });
});

// C5: third-party actions run by commit SHA only. A tag or branch can be moved by whoever controls the action's
// repository; a full commit SHA cannot. Every new `uses:` must follow the same rule or this suite fails.
describe('third-party actions are pinned to a full commit SHA', () => {
  const files = readdirSync(join(REPO_ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  const usesOf = (yaml: string) => [...yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map((m) => m[1]!);
  /** Verified against the official repositories (git ls-remote / fetch, 2026-11-02): tag → commit. */
  const APPROVED: Record<string, string> = {
    'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
    'pnpm/action-setup': 'b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0',
    'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    'cloudflare/wrangler-action': '9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3.15.0',
    'denoland/setup-deno': '22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5',
  };

  it('every `uses:` in every workflow is local or owner/repo@<40-hex SHA> # vX.Y.Z', () => {
    let count = 0;
    for (const f of files) {
      for (const uses of usesOf(read(f))) {
        count += 1;
        expect(unpinnedReason(uses), `${f}: uses: ${uses}`).toBeNull();
      }
    }
    expect(count).toBeGreaterThan(20);
  });

  it('every action is one of the reviewed pins, with the same SHA and version everywhere', () => {
    for (const f of files) {
      for (const uses of usesOf(read(f)).filter((u) => !u.startsWith('./'))) {
        const [repo, pin] = [uses.slice(0, uses.indexOf('@')), uses.slice(uses.indexOf('@') + 1)];
        expect(APPROVED[repo], `${f}: ${repo} is not a reviewed action (add its verified SHA to APPROVED)`).toBeDefined();
        expect(pin, `${f}: ${repo}`).toBe(APPROVED[repo]);
      }
    }
  });

  it('the rule rejects tags, branches, short SHAs, missing version comments and unpinned docker images', () => {
    expect(unpinnedReason('./.github/workflows/supabase-deploy.yml')).toBeNull();
    expect(unpinnedReason('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0')).toBeNull();
    expect(unpinnedReason('github/codeql-action/init@11d5960a326750d5838078e36cf38b85af677262 # v3.1.0')).toBeNull();
    expect(unpinnedReason('actions/checkout@v4')).toMatch(/not a full 40-character commit SHA/);
    expect(unpinnedReason('some/action@main')).toMatch(/not a full 40-character commit SHA/);
    expect(unpinnedReason('some/action@11d5960')).toMatch(/not a full 40-character commit SHA/);
    expect(unpinnedReason('some/action@11D5960A326750D5838078E36CF38B85AF677262 # v1.0.0')).toMatch(/not a full/);
    expect(unpinnedReason('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')).toMatch(/version comment/);
    expect(unpinnedReason('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4')).toMatch(/version comment/);
    expect(unpinnedReason('docker://alpine:3.20')).toMatch(/digest/);
    expect(unpinnedReason(`docker://alpine@sha256:${'a'.repeat(64)}`)).toBeNull();
    expect(unpinnedReason('checkout')).toMatch(/owner\/repo/);
  });
});

// D1: production Supabase credentials reach only the steps that use them.
describe('supabase-deploy.yml: Supabase secrets are step-scoped', () => {
  const job = jobBlock(read('supabase-deploy.yml'), 'deploy');
  const steps = stepsOf(job);
  const EXPECTED: Record<string, string[]> = {
    'Link the production project': ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD'],
    'Validate Session Pooler target': ['SUPABASE_DB_URL'],
    'Show pending migrations': ['SUPABASE_DB_URL'],
    'Read migration history and dry-run plan': ['SUPABASE_DB_URL'],
    'Apply migrations': ['SUPABASE_DB_URL'],
    'Verify migration history after push': ['SUPABASE_DB_URL'],
    'Deploy Edge Function checkout': ['SUPABASE_ACCESS_TOKEN'],
    'Deploy Edge Function my-orders': ['SUPABASE_ACCESS_TOKEN'],
    'Deploy Edge Function notification-settings': ['SUPABASE_ACCESS_TOKEN'],
    'Deploy Edge Function platform-admin': ['SUPABASE_ACCESS_TOKEN'],
    'List deployed Edge Functions': ['SUPABASE_ACCESS_TOKEN'],
  };

  it('the job-level env holds no secret (only the project ref)', () => {
    const head = job.slice(0, job.indexOf('\n    steps:\n'));
    expect(secretsIn(head)).toEqual([]);
    expect(head.endsWith('    env:\n      SUPABASE_PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}')).toBe(true);
  });

  it('each secret is passed through the env of exactly the steps that need it', () => {
    const actual = Object.fromEntries(steps.map((s) => [s.label, secretsIn(s.text)] as const).filter(([, v]) => v.length > 0));
    expect(actual).toEqual(EXPECTED);
    for (const s of steps.filter((x) => secretsIn(x.text).length > 0)) {
      // Only through `env:` of the step (KEY: ${{ secrets.KEY }}), never interpolated into a command.
      for (const line of s.text.split('\n').filter((l) => l.includes('secrets.'))) {
        expect(line, s.label).toMatch(/^ {10}([A-Z_]+): \$\{\{ secrets\.\1 \}\}$/);
      }
    }
  });

  it('checkout, pnpm install, the integrity check and the gate checks get no secret', () => {
    const clean = ['pnpm install --frozen-lockfile', 'actions/checkout@', 'pnpm/action-setup@', 'actions/setup-node@', 'Verify migration file integrity (SHA-256)', 'Project ref is the approved production project', 'Validate migration plan', 'Planned stages are release-allowed (no Contract stage)'];
    for (const needle of clean) {
      const step = steps.find((s) => s.text.includes(needle));
      expect(step, needle).toBeDefined();
      expect(secretsIn(step!.text), needle).toEqual([]);
    }
  });

  it('no step echoes a secret variable', () => {
    for (const s of steps) expect(s.text, s.label).not.toMatch(/(echo|printf|cat)\b[^\n]*\$\{?SUPABASE_(ACCESS_TOKEN|DB_PASSWORD|DB_URL)/);
  });
});

// D2: Cloudflare credentials only in the frontend job, environment-scoped names, no fallback to the old ones.
describe('release.yml: Cloudflare credentials are isolated in production-frontend', () => {
  const yaml = read('release.yml');

  it('PRODUCTION_CLOUDFLARE_* secrets appear only in the deploy step of the frontend job, which has environment production-frontend', () => {
    const frontend = jobBlock(yaml, 'frontend');
    expect(frontend).toContain('    environment: production-frontend\n');
    const withSecrets = stepsOf(frontend).filter((s) => secretsIn(s.text).length > 0);
    expect(withSecrets.map((s) => [s.label, secretsIn(s.text)])).toEqual([
      ['Deploy to Cloudflare Pages', ['PRODUCTION_CLOUDFLARE_ACCOUNT_ID', 'PRODUCTION_CLOUDFLARE_API_TOKEN']],
    ]);
    for (const name of jobNames(yaml).filter((n) => n !== 'frontend')) expect(secretsIn(job(name)), name).toEqual([]);
  });

  it('never uses the former repository-level CLOUDFLARE_* names, nor any fallback expression for a secret', () => {
    for (const f of ['ci.yml', 'release.yml', 'supabase-deploy.yml']) {
      const text = read(f);
      expect(text, f).not.toMatch(/(secrets|vars)\.CLOUDFLARE_/);
      expect(text, f).not.toMatch(/secrets\.[A-Za-z0-9_]+\s*\|\|/);
      expect(text, f).not.toMatch(/\|\|\s*secrets\./);
    }
    expect(yaml).toContain('--project-name=${{ vars.PRODUCTION_CLOUDFLARE_PAGES_PROJECT }}');
  });

  it('smoke-web derives the default production address from the frontend job, not from a repository variable', () => {
    expect(jobBlock(yaml, 'frontend')).toContain('      pages_project: ${{ vars.PRODUCTION_CLOUDFLARE_PAGES_PROJECT }}\n');
    expect(jobBlock(yaml, 'smoke-web')).toContain(
      "PRODUCTION_APP_URL: ${{ vars.PRODUCTION_APP_URL || format('https://{0}.pages.dev', needs.frontend.outputs.pages_project) }}",
    );
  });

  function job(name: string) {
    return jobBlock(yaml, name);
  }
});

describe('release.yml: backup is labelled as an operator attestation, smoke-api has no warn-only path', () => {
  const yaml = read('release.yml');
  it('backup_verified says it is not checked by the pipeline', () => {
    expect(yaml).toContain('description: Operator attestation, NOT checked by this pipeline');
  });
  it('smoke-api exports no legacy_frontend output (previous-frontend incompatibility fails the job)', () => {
    expect(yaml).not.toContain('legacy_frontend');
    const smoke = readFileSync(join(REPO_ROOT, 'scripts', 'release-smoke.ts'), 'utf8');
    expect(smoke).not.toMatch(/::warning|legacy_frontend|GITHUB_OUTPUT/);
    expect(smoke).toContain('assertLegacyFrontendQuery(');
  });
});

// L2: the Supabase project is pinned to the approved ref before link, before the build and (in the CLI) before smoke.
describe('Supabase project ref is validated before link and build', () => {
  const deploy = read('supabase-deploy.yml');
  const release = read('release.yml');

  it('supabase-deploy.yml checks the configured ref after the integrity check and before supabase link, without secrets', () => {
    const job = jobBlock(deploy, 'deploy');
    const order = inOrder(job, [
      'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
      'run: pnpm install --frozen-lockfile',
      'run: pnpm check:migration-integrity',
      '- name: Project ref is the approved production project\n        run: pnpm exec tsx scripts/release-preflight.ts project-ref\n',
      'supabase link --project-ref "$SUPABASE_PROJECT_REF"',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    const step = stepsOf(job).find((s) => s.label === 'Project ref is the approved production project')!;
    expect(secretsIn(step.text)).toEqual([]);
    expect(step.text).not.toMatch(/^\s*env:/m); // reads only the job-level SUPABASE_PROJECT_REF
    expect(deploy.match(/release-preflight\.ts project-ref/g)).toHaveLength(1);
  });

  it('the Session Pooler check pins the same approved ref as scripts/lib/release.ts', () => {
    expect(deploy).toContain(`if (process.env.SUPABASE_PROJECT_REF !== '${PRODUCTION_SUPABASE_PROJECT_REF}') {`);
  });

  it('frontend validates the exact VITE_SUPABASE_URL it builds with, in the same step, before pnpm build', () => {
    const build = stepsOf(jobBlock(release, 'frontend')).find((s) => s.label === 'Production build')!;
    const order = inOrder(build.text, [
      'VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}',
      'if [ -z "${!v}" ]',
      'SUPABASE_URL="$VITE_SUPABASE_URL" pnpm exec tsx scripts/release-preflight.ts supabase-url\n',
      'pnpm build',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect(secretsIn(build.text)).toEqual([]);
  });

  it('the smoke CLI validates SUPABASE_URL against the approved ref in both modes', () => {
    const smoke = readFileSync(join(REPO_ROOT, 'scripts', 'release-smoke.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(smoke).toContain('assertSupabaseProjectUrl(process.env.SUPABASE_URL, PRODUCTION_SUPABASE_PROJECT_REF)');
    expect(smoke).not.toContain("env('SUPABASE_URL')");
    expect(smoke.match(/= supabaseOrigin\(\);/g)).toHaveLength(2);
  });
});

// L1: every job that runs on a runner has an upper bound below GitHub's 360-minute default; database steps are bounded
// only by their (generous) job timeout, never by a short step timeout that could kill `db push` midway.
describe('job and step timeouts', () => {
  const release = read('release.yml');
  const deploy = read('supabase-deploy.yml');
  const jobTimeout = (job: string) => /^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1] ?? null;
  const stepTimeout = (step: string) => /^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1] ?? null;

  it('release.yml: each runner job has its bound; the caller of the reusable workflow has none (not allowed with uses:)', () => {
    expect(Object.fromEntries(jobNames(release).map((n) => [n, jobTimeout(jobBlock(release, n))]))).toEqual({
      preflight: '15',
      supabase: null,
      'smoke-api': '15',
      frontend: '30',
      'smoke-web': '20',
    });
    const caller = jobBlock(release, 'supabase');
    expect(caller).toContain('    uses: ./.github/workflows/supabase-deploy.yml\n');
    expect(caller).not.toMatch(/^\s*timeout-minutes:/m);
  });

  it('supabase-deploy.yml: the deploy job is bounded at 60 minutes', () => {
    expect(jobTimeout(jobBlock(deploy, 'deploy'))).toBe('60');
  });

  it('every job with runs-on has a timeout, none above 360 minutes', () => {
    for (const [file, yaml] of [['release.yml', release], ['supabase-deploy.yml', deploy]] as const) {
      for (const name of jobNames(yaml)) {
        const job = jobBlock(yaml, name);
        if (!/^ {4}runs-on:/m.test(job)) continue;
        const minutes = Number(jobTimeout(job));
        expect(minutes, `${file}: ${name}`).toBeGreaterThan(0);
        expect(minutes, `${file}: ${name}`).toBeLessThanOrEqual(360);
      }
    }
  });

  it('only the Edge Function deploy steps and the listing have step timeouts; no database step has one', () => {
    const steps = stepsOf(jobBlock(deploy, 'deploy'));
    const bounded = Object.fromEntries(steps.filter((s) => stepTimeout(s.text) !== null).map((s) => [s.label, stepTimeout(s.text)]));
    expect(bounded).toEqual({
      'Deploy Edge Function checkout': '10',
      'Deploy Edge Function my-orders': '10',
      'Deploy Edge Function notification-settings': '10',
      'Deploy Edge Function platform-admin': '10',
      'List deployed Edge Functions': '5',
    });
    for (const label of ['Link the production project', 'Validate Session Pooler target', 'Show pending migrations', 'Read migration history and dry-run plan', 'Apply migrations', 'Verify migration history after push']) {
      const step = steps.find((s) => s.label === label);
      expect(step, label).toBeDefined();
      expect(stepTimeout(step!.text), label).toBeNull();
    }
  });

  it('release.yml has no step-level timeouts (job bounds only)', () => {
    for (const name of jobNames(release)) {
      for (const s of stepsOf(jobBlock(release, name))) expect(stepTimeout(s.text), `${name}: ${s.label}`).toBeNull();
    }
  });
});
