// Invariants of the GitHub Actions workflows that protect production. The workflows are checked as text: the
// assertions are on exact commands and their order, so a reordering or a removed re-check fails here. YAML syntax and
// expressions are validated separately with actionlint.
import { readFileSync } from 'node:fs';
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
  const start = lines.indexOf(`  ${name}:`);
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

describe('supabase-deploy.yml', () => {
  const yaml = read('supabase-deploy.yml');

  it('serialises every production deployment and never cancels a running one', () => {
    const block = topLevelBlock(yaml, 'concurrency');
    expect(block).toBe('concurrency:\n  group: supabase-deploy-production\n  cancel-in-progress: false\n');
    // A fixed group: no expression, so runs from different refs / dispatches share it.
    expect(block).not.toContain('${{');
    // Only one concurrency setting (no job-level override that could split the group).
    expect(yaml.match(/^\s*concurrency:/gm)).toHaveLength(1);
  });

  it('stays manual-only and bound to the production environment', () => {
    expect(topLevelBlock(yaml, 'on')).toBe('on:\n  workflow_dispatch:\n');
    expect(yaml).toContain('    environment: production\n');
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

  it('keeps its own per-ref concurrency group, separate from production deployment', () => {
    expect(topLevelBlock(yaml, 'concurrency')).toBe('concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n');
    expect(yaml).not.toContain('supabase-deploy-production');
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

  it('deploys the frontend only after the Deno check passed', () => {
    expect(jobBlock(yaml, 'deploy-cloudflare-pages')).toContain('needs: [quality, integration, edge-functions-deno-check]');
  });
});
