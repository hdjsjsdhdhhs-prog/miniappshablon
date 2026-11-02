// Invariants of the GitHub Actions workflows that protect production. The workflows are checked as text: the
// assertions are on exact commands and their order, so a reordering or a removed re-check fails here. YAML syntax and
// expressions are validated separately with actionlint.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DENO_VERSION, REPO_ROOT } from './edge-functions';

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
      'uses: actions/checkout@v4\n        with:\n          ref: ${{ inputs.sha }}\n          persist-credentials: false',
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

  it('frontend builds the exact SHA, checks the bundle, and deploys with the existing Cloudflare names', () => {
    const order = inOrder(job('frontend'), [
      'if [ "$GITHUB_REF" != "refs/heads/main" ]',
      'ref: ${{ needs.preflight.outputs.sha }}\n          persist-credentials: false',
      'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
      'pnpm install --frozen-lockfile',
      'VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}',
      'VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}',
      'pnpm build',
      'run: pnpm check:bundle-secrets',
      'uses: cloudflare/wrangler-action@v3',
      'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      'command: pages deploy dist --project-name=${{ vars.CLOUDFLARE_PAGES_PROJECT }} --branch=main --commit-hash=${{ needs.preflight.outputs.sha }}',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect(yaml.match(/pages deploy/g)).toHaveLength(1);
  });

  it('smoke-web checks the deployment URL and the production address after the frontend deploy', () => {
    const web = job('smoke-web');
    expect(web).toContain('DEPLOYMENT_URL: ${{ needs.frontend.outputs.deployment_url }}');
    expect(web).toContain('run: pnpm exec tsx scripts/release-smoke.ts web "$DEPLOYMENT_URL" "$PRODUCTION_APP_URL"');
    expect(job('frontend')).toContain('deployment_url: ${{ steps.deploy.outputs.deployment-url }}');
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
