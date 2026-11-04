// Invariants of the GitHub Actions workflows that protect production. The workflows are checked as text: the
// assertions are on exact commands and their order, so a reordering or a removed re-check fails here. YAML syntax and
// expressions are validated separately with actionlint.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DENO_VERSION, REPO_ROOT } from './edge-functions';
import { MIGRATION_STAGES } from './migration-plan';
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
        '        required: true\n        type: string\n' +
        '    secrets:\n' +
        '      SUPABASE_ACCESS_TOKEN:\n        required: false\n' +
        '      SUPABASE_DB_PASSWORD:\n        required: false\n' +
        '      SUPABASE_DB_URL:\n        required: false\n',
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

  it('is started manually only, with the SHA and both data-protection flags as required inputs', () => {
    const on = topLevelBlock(yaml, 'on')!;
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(['  workflow_dispatch:']);
    expect(on.match(/^ {6}[a-z_]+:/gm)).toEqual(['      sha:', '      backup_reference:', '      backup_verified:', '      data_loss_accepted:']);
    for (const input of ['sha', 'backup_verified', 'data_loss_accepted']) {
      expect(on).toMatch(new RegExp(`\\n {6}${input}:\\n(?: {8}.*\\n)*? {8}required: true\\n`));
    }
    // Optional, so the data-loss path never needs a made-up backup name; the preflight still requires it for a backup.
    expect(on).toMatch(/\n {6}backup_reference:\n(?: {8}.*\n)*? {8}required: false\n(?: {8}.*\n)*? {8}type: string\n/);
    for (const flag of ['backup_verified', 'data_loss_accepted']) {
      expect(on).toMatch(new RegExp(`\\n {6}${flag}:\\n(?: {8}.*\\n)*? {8}type: boolean\\n(?: {8}.*\\n)*? {8}default: false\\n`));
    }
    expect(on).toContain(
      '      data_loss_accepted:\n        description: I acknowledge that no restorable backup exists and accept the loss of current database data.\n',
    );
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
      'DATA_LOSS_ACCEPTED: ${{ inputs.data_loss_accepted }}',
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
    // Secrets are used only by the frontend job (Cloudflare) and handed by name to the called Supabase workflow;
    // everything else is public or the run's token.
    for (const name of ['preflight', 'smoke-api', 'smoke-web']) expect(job(name)).not.toContain('secrets.');
  });

  // Regression (Production Release #1, "Access token not provided" at supabase link): a called workflow sees only the
  // secret names its caller passes, even for its own environment. The supabase job must hand over exactly the three
  // Supabase names, by explicit mapping, and the called workflow must declare exactly those names.
  it('passes exactly the Supabase secret names to supabase-deploy.yml, which declares exactly those', () => {
    const NAMES = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_URL'];
    const sup = job('supabase');
    expect(sup).toContain('    secrets:\n' + NAMES.map((n) => `      ${n}: \${{ secrets.${n} }}\n`).join(''));
    expect(secretsIn(sup)).toEqual(NAMES);
    const on = topLevelBlock(read('supabase-deploy.yml'), 'on')!;
    const declared = on.slice(on.indexOf('    secrets:\n'));
    expect([...declared.matchAll(/^ {6}([A-Z_]+):$/gm)].map((m) => m[1])).toEqual(NAMES);
    // Every secret the called workflow uses is one it declares (otherwise it would silently be empty there).
    expect(secretsIn(read('supabase-deploy.yml'))).toEqual(NAMES);
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

  it('link fails fast on an empty access token / DB password before the CLI runs, without printing a value', () => {
    const link = steps.find((s) => s.label === 'Link the production project')!;
    const order = inOrder(link.text, [
      'set -euo pipefail',
      'for v in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; do',
      'if [ -z "${!v:-}" ]; then echo "::error::secret $v is empty',
      'exit 1; fi',
      'pnpm exec supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    // The check names the variable only; it never expands a value into output.
    expect(link.text).not.toMatch(/echo[^\n]*\$\{!v\}|echo[^\n]*\$\{?SUPABASE_/);
    // It is the first step that uses a Supabase secret (before any database access).
    expect(steps.findIndex((s) => secretsIn(s.text).length > 0)).toBe(steps.indexOf(link));
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
    for (const name of jobNames(yaml).filter((n) => n !== 'frontend' && n !== 'supabase')) expect(secretsIn(job(name)), name).toEqual([]);
    expect(secretsIn(job('supabase'))).toEqual(['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_URL']);
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
  it('data_loss_accepted reaches only the preflight step, as its own variable (never as BACKUP_VERIFIED)', () => {
    expect(yaml.match(/inputs\.data_loss_accepted/g)).toHaveLength(1);
    expect(jobBlock(yaml, 'preflight')).toContain('          DATA_LOSS_ACCEPTED: ${{ inputs.data_loss_accepted }}\n');
    expect(yaml).not.toMatch(/BACKUP_VERIFIED: .*data_loss_accepted|DATA_LOSS_ACCEPTED: .*backup_verified/);
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
      '- name: Project ref is the approved production project\n        timeout-minutes: 2\n        run: pnpm exec tsx scripts/release-preflight.ts project-ref\n',
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

// L5: the Edge Functions are deployed by sequential, unconditional steps of ONE job, after the migrations are verified.
// RELEASE.md "Частичный деплой Edge Functions" describes failure and retry on exactly this structure (a re-run of the
// job repeats every step, so all four functions are redeployed); a change here must update that section.
describe('supabase-deploy.yml: Edge Functions deployment structure (partial deployment runbook)', () => {
  const deploy = read('supabase-deploy.yml');
  const job = jobBlock(deploy, 'deploy');
  const steps = stepsOf(job);
  const FUNCTIONS = ['checkout', 'my-orders', 'notification-settings', 'platform-admin'];

  it('one deploy job, no matrix: a re-run always repeats the whole job', () => {
    expect(jobNames(deploy)).toEqual(['deploy']);
    expect(job).not.toMatch(/^\s*(strategy|matrix):/m);
  });

  it('the functions are deployed after verify-applied, one step each, in a fixed order, then listed last', () => {
    const labels = steps.map((s) => s.label);
    const verify = labels.indexOf('Verify migration history after push');
    expect(verify).toBeGreaterThan(labels.indexOf('Apply migrations'));
    expect(labels.slice(verify + 1)).toEqual([...FUNCTIONS.map((f) => `Deploy Edge Function ${f}`), 'List deployed Edge Functions']);
    expect([...deploy.matchAll(/supabase functions deploy ([a-z0-9-]+)/g)].map((m) => m[1])).toEqual(FUNCTIONS);
  });

  it('every function step is unconditional and cannot be skipped or soft-failed', () => {
    for (const s of steps.filter((x) => x.label.startsWith('Deploy Edge Function ') || x.label === 'List deployed Edge Functions')) {
      expect(s.text, s.label).not.toMatch(/^ {8}if:/m);
      for (const bypass of ['continue-on-error', '|| true', '|| exit 0']) expect(s.text, s.label).not.toContain(bypass);
      expect(s.text, s.label).toMatch(/run: pnpm exec supabase functions (deploy [a-z0-9-]+|list) --project-ref "\$SUPABASE_PROJECT_REF"/);
    }
  });

  it('RELEASE.md documents the partial deployment without claiming atomicity', () => {
    const doc = readFileSync(join(REPO_ROOT, 'RELEASE.md'), 'utf8');
    expect(doc).toContain('## Частичный деплой Edge Functions');
    expect(doc).toContain('**Деплой функций не атомарный.**');
    for (const f of FUNCTIONS) expect(doc).toContain(`\`${f}\``);
    expect(deploy).toContain('RELEASE.md "Частичный деплой Edge Functions"');
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

  it('supabase-deploy.yml: the deploy job is bounded at 180 minutes (the budget below)', () => {
    expect(jobTimeout(jobBlock(deploy, 'deploy'))).toBe('180');
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

  // L-1 (Stage 22E): the deploy job budget. Every step before `Apply migrations` is non-mutating and bounded; the two
  // database mutation / verification steps have no step timeout; the Edge Function steps keep their bounds.
  const deploySteps = stepsOf(jobBlock(deploy, 'deploy'));
  const PRE_PUSH: Record<string, string> = {
    "Guard — called by release.yml on main for the run's SHA": '2',
    '- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0': '5',
    'Checked-out commit is the release SHA': '1',
    '- uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0': '5',
    '- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0': '5',
    '- run: pnpm install --frozen-lockfile': '10',
    'Verify migration file integrity (SHA-256)': '5',
    'Project ref is the approved production project': '2',
    'Link the production project': '5',
    'Validate Session Pooler target': '1',
    'Show pending migrations': '5',
    'Read migration history and dry-run plan': '10',
    'Validate migration plan': '5',
    'Planned stages are release-allowed (no Contract stage)': '2',
    'Time budget left for db push': '2',
  };
  const DATABASE_UNBOUNDED = ['Apply migrations', 'Verify migration history after push'];
  const FUNCTION_STEPS: Record<string, string> = {
    'Deploy Edge Function checkout': '10',
    'Deploy Edge Function my-orders': '10',
    'Deploy Edge Function notification-settings': '10',
    'Deploy Edge Function platform-admin': '10',
    'List deployed Edge Functions': '5',
  };
  const sum = (o: Record<string, string>) => Object.values(o).reduce((a, v) => a + Number(v), 0);
  const budgetEnv = (name: string) => {
    const step = deploySteps.find((s) => s.label === 'Time budget left for db push')!;
    return Number(new RegExp(`^ {10}${name}: '(\\d+)'$`, 'm').exec(step.text)?.[1]);
  };

  it('deploy job: the steps are exactly pre-push (bounded) → Apply + Verify (unbounded) → Edge Functions (bounded)', () => {
    expect(deploySteps.map((s) => s.label)).toEqual([...Object.keys(PRE_PUSH), ...DATABASE_UNBOUNDED, ...Object.keys(FUNCTION_STEPS)]);
  });

  it('every non-mutating step before db push has its step timeout', () => {
    const bounded = Object.fromEntries(deploySteps.filter((s) => stepTimeout(s.text) !== null).map((s) => [s.label, stepTimeout(s.text)]));
    expect(bounded).toEqual({ ...PRE_PUSH, ...FUNCTION_STEPS });
    for (const s of deploySteps) expect(s.text.match(/timeout-minutes:/g)?.length ?? 0, s.label).toBeLessThanOrEqual(1);
  });

  it('no step timeout on the database mutation and verification steps; db push happens only there', () => {
    for (const label of DATABASE_UNBOUNDED) {
      const step = deploySteps.find((s) => s.label === label);
      expect(step, label).toBeDefined();
      expect(step!.text, label).not.toMatch(/timeout-minutes:/);
    }
    const push = deploySteps.filter((s) => /supabase db push(?! --dry-run)/.test(s.text)).map((s) => s.label);
    expect(push).toEqual(['Apply migrations']);
  });

  it('the budget is internally consistent: pre-push + reserve + functions + margin = job timeout ≤ 360', () => {
    const job = Number(jobTimeout(jobBlock(deploy, 'deploy')));
    expect(budgetEnv('JOB_TIMEOUT_MINUTES')).toBe(job);
    expect(budgetEnv('FUNCTIONS_MINUTES')).toBe(sum(FUNCTION_STEPS));
    expect(budgetEnv('PUSH_RESERVE_MINUTES')).toBe(60);
    expect(budgetEnv('RUNNER_MARGIN_MINUTES')).toBe(10);
    // The latest allowed push start equals the sum of the pre-push step bounds: on paper, the bounds can never use the
    // reserve; the measured check catches whatever they do not cover.
    const latest = job - budgetEnv('PUSH_RESERVE_MINUTES') - budgetEnv('FUNCTIONS_MINUTES') - budgetEnv('RUNNER_MARGIN_MINUTES');
    expect(latest).toBe(sum(PRE_PUSH));
    expect(latest).toBe(65);
    expect(job).toBeLessThanOrEqual(360);
    expect(deploy).toContain(`    #   pre-push steps (non-mutating, each bounded)  ${sum(PRE_PUSH)}`);
    expect(deploy).toContain(`    #   job timeout                                   ${job} (GitHub maximum 360)`);
  });

  it('the guard records the job start first; the budget check refuses db push fail-closed, without secrets', () => {
    const guard = deploySteps[0]!.text;
    expect(inOrder(guard, ['set -euo pipefail\n', 'echo "DEPLOY_JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"\n', 'if [ "$GITHUB_REF" != "refs/heads/main" ]']).every((i) => i >= 0)).toBe(true);
    const labels = deploySteps.map((s) => s.label);
    expect(labels.indexOf('Time budget left for db push')).toBe(labels.indexOf('Apply migrations') - 1);
    const step = deploySteps.find((s) => s.label === 'Time budget left for db push')!.text;
    expect(step).toContain("        if: steps.plan.outputs.mode == 'apply'\n");
    expect(secretsIn(step)).toEqual([]);
    for (const needle of [
      'set -euo pipefail',
      'if ! [[ "${DEPLOY_JOB_STARTED_AT:-}" =~ ^[0-9]+$ ]]; then',
      'latest=$(( JOB_TIMEOUT_MINUTES - PUSH_RESERVE_MINUTES - FUNCTIONS_MINUTES - RUNNER_MARGIN_MINUTES ))',
      'if [ "$latest" -le 0 ] || [ "$elapsed" -lt 0 ] || [ "$elapsed" -gt $(( latest * 60 )) ]; then',
    ]) {
      expect(step).toContain(needle);
    }
    for (const bypass of ['continue-on-error', '|| true', '|| exit 0']) expect(step).not.toContain(bypass);
    expect(step.match(/exit 1/g)).toHaveLength(2);
  });

  // The budget check's own shell script, run under bash with its own env values (Git Bash on Windows, bash on CI).
  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  const bashWorks = (process.platform !== 'win32' || existsSync(bash)) && spawnSync(bash, ['-c', 'exit 0']).status === 0;
  it.skipIf(!bashWorks)('the budget check passes within 65 minutes since the guard and refuses later, missing or malformed starts', () => {
    const step = deploySteps.find((s) => s.label === 'Time budget left for db push')!.text;
    const script = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
    const env = Object.fromEntries(['JOB_TIMEOUT_MINUTES', 'PUSH_RESERVE_MINUTES', 'FUNCTIONS_MINUTES', 'RUNNER_MARGIN_MINUTES'].map((n) => [n, String(budgetEnv(n))]));
    const now = Math.floor(Date.now() / 1000);
    const run = (started: string | undefined) => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DEPLOY_JOB_STARTED_AT'));
      return spawnSync(bash, ['-c', script], { env: { ...base, ...env, ...(started === undefined ? {} : { DEPLOY_JOB_STARTED_AT: started }) }, encoding: 'utf8' });
    };
    for (const minutes of [0, 30, 64]) expect(run(String(now - minutes * 60)).status, `${minutes} min`).toBe(0);
    for (const minutes of [66, 120, 200]) {
      const r = run(String(now - minutes * 60));
      expect(r.status, `${minutes} min`).toBe(1);
      expect(r.stdout, `${minutes} min`).toContain('Refusing to start db push');
    }
    for (const bad of [undefined, '', 'abc', '-5', `${now}x`]) {
      const r = run(bad);
      expect(r.status, String(bad)).toBe(1);
      expect(r.stdout, String(bad)).toMatch(/refusing to start db push/i);
    }
    expect(run(String(now + 3600)).status, 'start in the future').toBe(1);
  });

  it('release.yml has no step-level timeouts (job bounds only)', () => {
    for (const name of jobNames(release)) {
      for (const s of stepsOf(jobBlock(release, name))) expect(stepTimeout(s.text), `${name}: ${s.label}`).toBeNull();
    }
  });
});

/** RELEASE.md with whitespace collapsed (the Markdown is hard-wrapped). */
const releaseDoc = () => readFileSync(join(REPO_ROOT, 'RELEASE.md'), 'utf8').replace(/\s+/g, ' ');
/** The text of a `## ` section of RELEASE.md (whitespace collapsed). */
const docSection = (title: string) => {
  const doc = releaseDoc();
  const start = doc.indexOf(`## ${title} `);
  if (start < 0) throw new Error(`RELEASE.md section "${title}" not found`);
  const end = doc.indexOf(' ## ', start + 3);
  return doc.slice(start, end < 0 ? undefined : end);
};

// L-1 / L-2 (Stage 22E): the time budget and the interrupted-push runbook match the workflow and the CLI evidence.
describe('RELEASE.md: interrupted db push (Cancel or timeout)', () => {
  const deploy = read('supabase-deploy.yml');

  it('the budget section states the job timeout and the measured pre-push limit of the workflow', () => {
    const budget = docSection('Бюджет времени job `deploy`');
    expect(budget).toContain('ограничен **180 минутами**');
    expect(budget).toContain('сумма 65');
    expect(budget).toContain('**без** таймаута шага, резерв 60');
    expect(budget).toContain('больше 65 минут (180 − 60 − 45 − 10)');
    expect(budget).toContain('`Time budget left for db push`');
  });

  it('treats Cancel and a job timeout alike and never claims the file in flight is rolled back or committed', () => {
    const section = docSection('Прерванный db push (Cancel или таймаут)');
    expect(section).toContain('Cancel workflow, таймаут job `deploy`');
    expect(section).toContain('Для разбора это **одна и та же ситуация**');
    expect(section).toContain('Результат файла, выполнявшегося в момент прерывания, **неизвестен**');
    expect(section).toContain('Нельзя утверждать ни «файл всегда откатывается», ни «файл всегда фиксируется»');
    expect(section).toContain('а **не** проверенная гарантия');
    for (const text of [deploy, releaseDoc()]) {
      expect(text).not.toMatch(/rolled back with its transaction|is always rolled back|is always committed/);
    }
    expect(deploy).toContain('the outcome of the migration file in flight is UNCERTAIN');
    expect(deploy).toContain('RELEASE.md "Прерванный db push (Cancel или таймаут)"');
    expect(releaseDoc()).toContain('`db push` (Cancel **или** таймаут job) может оставить стадию частично применённой');
  });

  it('requires inspecting the remote history against the manifest before any retry, and stopping on inconsistency', () => {
    const section = docSection('Прерванный db push (Cancel или таймаут)');
    const order = inOrder(section, [
      '**Не нажимайте Re-run**',
      'pg_stat_activity',
      'supabase migration list',
      '`MIGRATION_STAGES` в `scripts/lib/migration-plan.ts` (3A — 5 файлов, 3B — 4)',
      '**применена целиком**, **не начата** или **частично**',
      'scripts/check-production-migration-plan.ts plan list.json dry.json',
      '**Подтверждённо применённой** считается версия',
      'остаётся **неопределённым**',
      '**стоп**: никаких дальнейших попыток миграции',
      'допустим Re-run',
    ]);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect(MIGRATION_STAGES.map((s) => [s.id, s.files.length])).toEqual([['3A', 5], ['3B', 4]]);
  });

  it('names the CLI version the evidence was read from, equal to the locked supabase CLI', () => {
    const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const versions = [...new Set([...lock.matchAll(/^ {2}supabase@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]))];
    expect(versions).toHaveLength(1);
    expect(docSection('Прерванный db push (Cancel или таймаут)')).toContain(`(\`supabase\` ${versions[0]} из \`pnpm-lock.yaml\``);
  });

  it('the premise holds: no release-stage migration has a statement the CLI runs outside the file batch', () => {
    // Statement forms the CLI (pkg/migration/file.go isPipelineIncompatible) executes separately from the batch.
    const incompatible = [
      /\b(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b/i,
      /\bREINDEX\b[^;]*\bCONCURRENTLY\b/i,
      /^\s*(VACUUM|CLUSTER)\b/im,
      /^\s*ALTER\s+SYSTEM\b/im,
      /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im, // explicit transaction control would split the batch too
    ];
    for (const file of MIGRATION_STAGES.flatMap((s) => [...s.files])) {
      const sql = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', file), 'utf8');
      for (const re of incompatible) expect(re.test(sql), `${file}: ${re}`).toBe(false);
    }
  });
});

// L-3 (Stage 22E): new run vs re-run of an existing run; no absolute "an old commit can never be released".
describe('RELEASE.md: historical SHA and workflow re-runs', () => {
  it('drops the absolute statements that a re-run contradicts', () => {
    const doc = releaseDoc();
    for (const wrong of [
      'Pipeline старый коммит выпустить не может',
      'Release pipeline старый коммит выпустить не может',
      'Выбрать произвольный (в том числе более старый) коммит нельзя',
      'релизится только HEAD `main`',
    ]) {
      expect(doc, wrong).not.toContain(wrong);
    }
    expect(doc).toContain('**новый** запуск (Run workflow) всегда берёт текущий HEAD `main`. Исключение — **повтор существующего запуска** (Re-run)');
  });

  it('documents the re-run semantics and the GitHub limits', () => {
    const doc = releaseDoc();
    const start = doc.indexOf('**Повтор существующего запуска и исторический SHA.**');
    expect(start).toBeGreaterThan(0);
    const text = doc.slice(start, doc.indexOf('**Concurrency.**', start));
    for (const needle of [
      'по официальной документации «Re-running workflows and jobs»',
      'Повтор **сохраняет** `GITHUB_SHA` и `GITHUB_REF` исходного события и его inputs: ввести при повторе другой SHA нельзя',
      '**30 дней**',
      '**не более 50 раз** (полные и частичные повторы вместе)',
      '**уже не самый новый SHA может быть выпущен ещё раз**',
      '**Re-run all jobs** повторяет `preflight`',
      'SHA, которого больше **нет в истории текущего** `main` (`behind`, `diverged`, переписанная история), отклоняется',
      'Совпадения с текущим HEAD preflight **не** требует (`ahead` допустим)',
      '**Re-run failed jobs** и **Re-run a specific job** успешный `preflight` **не** повторяют',
      'compare с текущим `main` заново **не** выполняется',
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it('the Rollback section no longer presents a re-run as impossible or as a rollback', () => {
    const doc = releaseDoc();
    const rollback = doc.slice(doc.indexOf('**Откат.**'), doc.indexOf('## Бюджет времени job `deploy`'));
    expect(rollback).toContain('Новый запуск pipeline выпускает только текущий HEAD `main`');
    expect(rollback).toContain('это повтор всего прежнего релиза, а не откат');
  });
});
