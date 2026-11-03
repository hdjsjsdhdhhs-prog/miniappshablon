import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_STAGES } from './migration-plan';
import {
  assertAllowedStages,
  assertBackupConfirmation,
  assertCiWorkflowRun,
  assertCommitOnMain,
  assertEnvironmentProtected,
  assertReleaseRef,
  assertReleaseSha,
  assertRequiredChecks,
  GITHUB_ACTIONS_APP_ID,
  parseStageList,
  RELEASE_ALLOWED_STAGES,
  REQUIRED_CI_CHECKS,
  type CheckRun,
  type Environment,
  type WorkflowRun,
} from './release';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('ref and event', () => {
  it('accepts only a manual run from main', () => {
    expect(() => assertReleaseRef('refs/heads/main', 'workflow_dispatch')).not.toThrow();
    for (const ref of ['refs/heads/security/release-pipeline', 'refs/heads/mainx', 'refs/tags/main', 'refs/pull/2/merge', undefined]) {
      expect(() => assertReleaseRef(ref, 'workflow_dispatch'), String(ref)).toThrow(/refs\/heads\/main/);
    }
    for (const event of ['push', 'pull_request', 'workflow_call', 'schedule', undefined]) {
      expect(() => assertReleaseRef('refs/heads/main', event), String(event)).toThrow(/manually/);
    }
  });
});

describe('release SHA', () => {
  it('must be the full lowercase SHA of the run', () => {
    expect(assertReleaseSha(SHA, SHA)).toBe(SHA);
    expect(assertReleaseSha(` ${SHA}\n`, SHA)).toBe(SHA);
  });
  it('rejects short, uppercase, non-hex, empty SHAs', () => {
    for (const bad of [SHA.slice(0, 7), SHA.slice(0, 39), SHA.toUpperCase(), `${SHA.slice(0, 39)}g`, '', 'main', 'HEAD', undefined]) {
      expect(() => assertReleaseSha(bad, SHA), String(bad)).toThrow(/full 40-character/);
    }
  });
  it('rejects a SHA that is not the commit the run was started for', () => {
    expect(() => assertReleaseSha(OTHER, SHA)).toThrow(/not the commit this run was started for/);
    expect(() => assertReleaseSha(SHA, undefined)).toThrow(/GITHUB_SHA/);
  });
});

// GitHub compare `<sha>...main`: base = the release SHA, head = main; status / *_by describe main relative to the SHA.
describe('release SHA is in the history of main (compare <sha>...main)', () => {
  it('passes when main is the SHA (identical, behind_by 0)', () => {
    expect(() => assertCommitOnMain({ status: 'identical', ahead_by: 0, behind_by: 0 })).not.toThrow();
  });
  it('passes when main only moved forward on top of the SHA (ahead, behind_by 0)', () => {
    expect(() => assertCommitOnMain({ status: 'ahead', ahead_by: 3, behind_by: 0 })).not.toThrow();
  });
  it('rejects a SHA that main does not contain: behind (main is an ancestor of the SHA)', () => {
    expect(() => assertCommitOnMain({ status: 'behind', ahead_by: 0, behind_by: 2 })).toThrow(/not in the history of main[\s\S]*"behind"/);
  });
  it('rejects a SHA on a diverged history', () => {
    expect(() => assertCommitOnMain({ status: 'diverged', ahead_by: 4, behind_by: 1 })).toThrow(/not in the history of main[\s\S]*"diverged"/);
  });
  it('rejects a non-zero behind_by even when the status claims identical / ahead (inconsistent answer)', () => {
    for (const status of ['identical', 'ahead']) {
      expect(() => assertCommitOnMain({ status, ahead_by: 1, behind_by: 1 }), status).toThrow(/not in the history of main/);
    }
  });
  it('fails closed on a missing, null, non-numeric or invalid behind_by', () => {
    for (const behind_by of [undefined, null, '0', 0.5, -1, Number.NaN]) {
      expect(() => assertCommitOnMain({ status: 'ahead', ahead_by: 1, behind_by }), String(behind_by)).toThrow(/malformed compare result/);
    }
    expect(() => assertCommitOnMain({ status: 'identical' })).toThrow(/malformed compare result: behind_by missing/);
  });
  it('fails closed on no response (404 → null) and on unknown / missing statuses', () => {
    expect(() => assertCommitOnMain(null)).toThrow(/no compare result/);
    expect(() => assertCommitOnMain(undefined)).toThrow(/no compare result/);
    for (const status of [undefined, '', 'IDENTICAL', 'unknown']) {
      expect(() => assertCommitOnMain({ status, behind_by: 0 }), String(status)).toThrow(/not in the history of main/);
    }
  });
});

/**
 * The preflight CLI against a local stand-in for the GitHub API (GITHUB_API_URL): the real fetch → gh() →
 * assertCommitOnMain path. Only /compare is answered; every other path is 404, so a compare that PASSES is followed by
 * the CI-run check failing with "no CI run" — proof that the run got past the ancestry check, and still exits non-zero.
 */
describe('release-preflight.ts preflight: the compare call fails closed', () => {
  type Answer = { status: number; body: string };
  let answer: Answer = { status: 500, body: '' };
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const isCompare = (req.url ?? '').startsWith(`/repos/o/r/compare/${SHA}...main`);
    const { status, body } = isCompare ? answer : { status: 404, body: '{"message":"Not Found"}' };
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
  });
  let api = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const preflight = (a: Answer) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      answer = a;
      const child = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-preflight.ts', 'preflight'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_API_URL: api,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_TOKEN: 'test-token',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_SHA: SHA,
          RELEASE_SHA: SHA,
          BACKUP_VERIFIED: 'true',
          BACKUP_REFERENCE: 'backup-test-1',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  const PASSED = 'is in the history of main';

  it('ahead with behind_by 0 passes the ancestry check (then stops at the next check)', async () => {
    const r = await preflight({ status: 200, body: JSON.stringify({ status: 'ahead', ahead_by: 2, behind_by: 0 }) });
    expect(r.stdout, r.stderr).toContain(`OK  ${SHA} ${PASSED} (ahead)`);
    expect(r.stderr).toMatch(/no CI run/);
    expect(r.code).toBe(1);
    expect(requests.some((u) => u.startsWith(`/repos/o/r/compare/${SHA}...main`))).toBe(true);
  }, 60_000);

  const rejected: Array<[string, Answer, RegExp]> = [
    ['behind', { status: 200, body: JSON.stringify({ status: 'behind', ahead_by: 0, behind_by: 3 }) }, /not in the history of main[\s\S]*"behind"/],
    ['diverged', { status: 200, body: JSON.stringify({ status: 'diverged', ahead_by: 1, behind_by: 2 }) }, /"diverged"/],
    ['missing behind_by', { status: 200, body: JSON.stringify({ status: 'ahead', ahead_by: 1 }) }, /malformed compare result/],
    ['HTTP 500', { status: 500, body: '{"message":"Server Error"}' }, /GitHub API \/compare\/[0-9a-f]{40}\.\.\.main answered 500/],
    ['HTTP 403', { status: 403, body: '{"message":"Forbidden"}' }, /answered 403/],
    ['HTTP 404 (unknown commit)', { status: 404, body: '{"message":"Not Found"}' }, /no compare result/],
    ['body is not JSON', { status: 200, body: '<html>oops</html>' }, /JSON/],
  ];
  for (const [what, a, error] of rejected) {
    it(`rejects: ${what}`, async () => {
      const r = await preflight(a);
      expect(r.code, r.stdout).toBe(1);
      expect(r.stderr).toMatch(error);
      expect(r.stderr).toContain('Release stopped: nothing was deployed by this step.');
      expect(r.stdout).not.toContain(PASSED);
    }, 60_000);
  }
});

describe('backup confirmation', () => {
  it('requires backup_verified=true and a reference', () => {
    expect(assertBackupConfirmation('true', ' pitr-2026-11-02T10:00Z ')).toBe('pitr-2026-11-02T10:00Z');
    for (const v of ['false', '', 'TRUE', '1', 'yes', undefined]) expect(() => assertBackupConfirmation(v, 'backup-1'), String(v)).toThrow(/backup_verified/);
    for (const r of ['', '  ', 'ab', undefined]) expect(() => assertBackupConfirmation('true', r), String(r)).toThrow(/backup_reference is empty/);
  });
  it('rejects multi-line or oversized references (no forged log lines)', () => {
    expect(() => assertBackupConfirmation('true', 'backup\n::error::fake')).toThrow(/single line/);
    expect(() => assertBackupConfirmation('true', 'a\u0007b c')).toThrow(/single line/);
    expect(() => assertBackupConfirmation('true', 'x'.repeat(201))).toThrow(/200/);
  });
});

const check = (name: string, over: Partial<CheckRun> = {}): CheckRun => ({
  id: 1,
  name,
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  app: { id: GITHUB_ACTIONS_APP_ID, slug: 'github-actions' },
  ...over,
});
const allGreen = () => REQUIRED_CI_CHECKS.map((n, i) => check(n, { id: 10 + i }));

describe('required CI checks', () => {
  it('names the three checks of the protect-main ruleset', () => {
    expect(REQUIRED_CI_CHECKS).toEqual([
      'Lint · types · unit · build',
      'Edge Functions · deno check',
      'SQL/integration + Playwright (local Supabase in Docker)',
    ]);
  });
  it('passes when all three are green on the SHA', () => {
    expect(() => assertRequiredChecks(allGreen(), SHA)).not.toThrow();
  });
  it('fails when a check is missing, failed, pending, skipped, on another SHA or from another app', () => {
    for (const name of REQUIRED_CI_CHECKS) {
      expect(() => assertRequiredChecks(allGreen().filter((c) => c.name !== name), SHA), name).toThrow(/not green/);
    }
    const variants: Array<Partial<CheckRun>> = [
      { conclusion: 'failure' },
      { conclusion: 'skipped' },
      { conclusion: 'cancelled' },
      { status: 'in_progress', conclusion: null },
      { head_sha: OTHER },
      { app: { id: 999, slug: 'impostor' } },
      { app: null },
    ];
    for (const over of variants) {
      const runs = allGreen().map((c, i) => (i === 1 ? { ...c, ...over } : c));
      expect(() => assertRequiredChecks(runs, SHA), JSON.stringify(over)).toThrow(/Edge Functions · deno check/);
    }
  });
  it('uses the latest run of a check: a red re-run after a green one fails, a green re-run after a red one passes', () => {
    const name = REQUIRED_CI_CHECKS[0];
    const rest = allGreen().slice(1);
    expect(() => assertRequiredChecks([check(name, { id: 1 }), check(name, { id: 2, conclusion: 'failure' }), ...rest], SHA)).toThrow();
    expect(() => assertRequiredChecks([check(name, { id: 1, conclusion: 'failure' }), check(name, { id: 2 }), ...rest], SHA)).not.toThrow();
  });
});

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  path: '.github/workflows/ci.yml',
  head_sha: SHA,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  ...over,
});

describe('CI workflow run', () => {
  it('requires a successful ci.yml push run on main for the SHA', () => {
    expect(() => assertCiWorkflowRun([run()], SHA)).not.toThrow();
    expect(() => assertCiWorkflowRun([], SHA)).toThrow(/no CI run/);
    for (const over of [{ event: 'pull_request' }, { head_branch: 'feature' }, { path: '.github/workflows/release.yml' }, { head_sha: OTHER }]) {
      expect(() => assertCiWorkflowRun([run(over)], SHA), JSON.stringify(over)).toThrow(/no CI run/);
    }
    for (const over of [{ conclusion: 'failure' }, { status: 'in_progress', conclusion: null }, { conclusion: 'cancelled' }]) {
      expect(() => assertCiWorkflowRun([run(over)], SHA), JSON.stringify(over)).toThrow(/latest CI run/);
    }
  });
  it('judges the latest run for the SHA', () => {
    expect(() => assertCiWorkflowRun([run({ id: 1 }), run({ id: 2, conclusion: 'failure' })], SHA)).toThrow();
    expect(() => assertCiWorkflowRun([run({ id: 1, conclusion: 'failure' }), run({ id: 2 })], SHA)).not.toThrow();
  });
});

describe('migration stages allowed in a release', () => {
  it('are the Expand stages 3A and 3B — the current manifest passes', () => {
    expect(RELEASE_ALLOWED_STAGES).toEqual(['3A', '3B']);
    expect(() => assertAllowedStages(MIGRATION_STAGES.map((s) => s.id))).not.toThrow();
  });
  it('a Contract stage (3C) in the manifest or in the gate plan stops the release', () => {
    expect(() => assertAllowedStages(['3A', '3B', '3C'])).toThrow(/3C are not allowed/);
    expect(() => assertAllowedStages(parseStageList('3B,3C'))).toThrow(/3C/);
  });
  it('planned stage lists: empty (skip), one or several stages; nothing else', () => {
    expect(parseStageList('')).toEqual([]);
    expect(parseStageList(undefined)).toEqual([]);
    expect(parseStageList('3B')).toEqual(['3B']);
    expect(parseStageList('3A,3B')).toEqual(['3A', '3B']);
    for (const bad of ['3A, 3B', '3a', 'all', '3A;3C', '3A,,3B']) expect(() => parseStageList(bad), bad).toThrow(/invalid stage list/);
  });
});

const protectedEnv = (name: string, over: Partial<Environment> = {}): Environment => ({
  name,
  can_admins_bypass: false,
  protection_rules: [{ type: 'branch_policy' }, { type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  ...over,
});
const mainOnly = [{ name: 'main', type: 'branch' }];

describe('deployment environment protection', () => {
  it('accepts an existing environment with a reviewer, no admin bypass and main-only deployments', () => {
    expect(() => assertEnvironmentProtected('production', protectedEnv('production'), mainOnly)).not.toThrow();
    expect(() => assertEnvironmentProtected('production-frontend', protectedEnv('production-frontend'), [{ name: 'main' }])).not.toThrow();
  });
  it('a missing environment stops the release (it would be auto-created unprotected)', () => {
    expect(() => assertEnvironmentProtected('production-frontend', null, null)).toThrow(/does not exist/);
  });
  it('rejects every weaker configuration', () => {
    const cases: Array<[Partial<Environment>, (typeof mainOnly) | Array<{ name: string; type?: string }>, RegExp]> = [
      [{ protection_rules: [{ type: 'branch_policy' }] }, mainOnly, /no required reviewer/],
      [{ protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }, mainOnly, /no required reviewer/],
      [{ can_admins_bypass: true }, mainOnly, /bypass/],
      [{ deployment_branch_policy: null }, mainOnly, /not limited/],
      [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, mainOnly, /not limited/],
      [{}, [], /exactly \[main\]/],
      [{}, [{ name: 'main' }, { name: 'security/*' }], /exactly \[main\]/],
      [{}, [{ name: '*' }], /exactly \[main\]/],
      [{}, [{ name: 'main', type: 'tag' }], /exactly \[main\]/],
    ];
    for (const [over, policies, error] of cases) {
      expect(() => assertEnvironmentProtected('production', protectedEnv('production', over), policies), JSON.stringify(over)).toThrow(error);
    }
  });
});
