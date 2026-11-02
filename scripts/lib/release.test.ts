import { describe, expect, it } from 'vitest';
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
  it('requires the commit to be in the history of main', () => {
    expect(() => assertCommitOnMain('identical')).not.toThrow();
    expect(() => assertCommitOnMain('behind')).not.toThrow();
    for (const status of ['ahead', 'diverged', undefined]) expect(() => assertCommitOnMain(status), String(status)).toThrow(/history of main/);
  });
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
