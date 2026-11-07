import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APPLIED_BASELINE_MIGRATION_FILES,
  assertLocalMigrationFiles,
  assertManifestValid,
  assertReleaseApplied,
  decideProductionMigrationPlan,
  MIGRATION_STAGES,
  parseDryRun,
  parseMigrationList,
  REVIEWED_MIGRATION_FILES,
  REVIEWED_MIGRATIONS,
} from './migration-plan';

// Fixtures follow the real JSON of Supabase CLI 2.120.0 (`--agent no --output-format json`).
const v = (file: string) => file.slice(0, 14);
const BASE = APPLIED_BASELINE_MIGRATION_FILES.map(v);
const A_FILES = [...MIGRATION_STAGES[0].files];
const B_FILES = [...MIGRATION_STAGES[1].files];
const C_FILES = [...MIGRATION_STAGES[2].files];
const A = A_FILES.map(v);
const B = B_FILES.map(v);
const C = C_FILES.map(v);
const ALL = [...REVIEWED_MIGRATIONS];
// After every reviewed version (an unknown migration added later).
const EXTRA = '20261120090000';
const FILES: Record<string, string> = Object.fromEntries(REVIEWED_MIGRATION_FILES.map((f) => [v(f), f]));

type Row = [local: string, remote: string];
const applied = (x: string): Row => [x, x];
const pending = (x: string): Row => [x, ''];
const list = (rows: Row[]) =>
  JSON.stringify({ migrations: rows.map(([local, remote]) => ({ local, remote, time: '2026-11-02 09:00:00' })), message: 'Migrations listed' });
const dryRunFiles = (files: string[]) =>
  JSON.stringify({
    upToDate: files.length === 0,
    dryRun: true,
    migrations: files,
    seeds: [],
    roles: [],
    message: files.length === 0 ? 'Remote database is up to date.' : 'Finished supabase db push.',
  });
const dryRun = (versions: string[]) => dryRunFiles(versions.map((x) => FILES[x] ?? `${x}_x.sql`));
/** Full history where exactly the versions in `done` are applied. */
const history = (done: readonly string[]) => list(ALL.map((x) => (done.includes(x) ? applied(x) : pending(x))));

// Migration plan fixture: reviewed baseline followed by ordered hardening stages.
const production = history(BASE);
const afterA = history([...BASE, ...A]);
const afterB = history([...BASE, ...A, ...B]);
const allApplied = history(ALL);

const apply = (stages: string[], files: string[]) => ({ mode: 'apply', stages, files });

describe('reviewed manifest', () => {
  it('is exactly the reviewed baseline followed by the ordered release stages, by explicit file name', () => {
    expect(APPLIED_BASELINE_MIGRATION_FILES).toEqual([
      '20261014090000_core_schema.sql',
      '20261014090100_access_control.sql',
      '20261014090200_order_functions.sql',
      '20261014090300_storage.sql',
      '20261014090400_fix_create_order_locking.sql',
      '20261014090500_fix_theme_validation_nulls.sql',
      '20261017090000_harden_function_privileges.sql',
      '20261025090000_telegram_notifications_and_platform_admin.sql',
      '20261025090100_notification_secret_cleanup.sql',
      '20261026090000_fulfillment_and_demo_lifecycle.sql',
      '20261026100000_admin_catalog_delete.sql',
    ]);
    expect(MIGRATION_STAGES.map((s) => s.id)).toEqual(['3A', '3B', '4A']);
    expect(A_FILES).toEqual([
      '20261030090000_owner_change_security.sql',
      '20261030090100_checkout_demo_guard_and_limits.sql',
      '20261031090000_handover_reservation.sql',
      '20261101090000_handover_invite_cooldown_and_stale_release.sql',
      '20261101100000_handover_cancel_keeps_live_reservation.sql',
    ]);
    expect(B_FILES).toEqual([
      '20261102090000_platform_admin_mfa.sql',
      '20261102090100_stock_status_projection.sql',
      '20261102090200_demo_shop_deletion.sql',
      '20261102090300_platform_admin_mfa_recovery.sql',
    ]);
    expect(C_FILES).toEqual(['20261107090000_telegram_bot_connection.sql']);
    expect(REVIEWED_MIGRATION_FILES).toHaveLength(21);
    expect(() => assertManifestValid()).not.toThrow();
  });

  it('the manifest self-check rejects patterns, bad names and wrong order', () => {
    expect(() => assertManifestValid(['20261030090000_*.sql'])).toThrow(/not an exact/);
    expect(() => assertManifestValid(['2026103009000_short.sql'])).toThrow(/not an exact/);
    expect(() => assertManifestValid(['20261030090000_Owner.sql'])).toThrow(/not an exact/);
    expect(() => assertManifestValid([A_FILES[1]!, A_FILES[0]!])).toThrow(/strictly after/);
    expect(() => assertManifestValid([A_FILES[0]!, A_FILES[0]!])).toThrow(/strictly after/);
  });

  it('supabase/migrations contains exactly the reviewed file names', () => {
    const local = readdirSync(join(process.cwd(), 'supabase', 'migrations'));
    expect(() => assertLocalMigrationFiles(local)).not.toThrow();
    expect([...local].sort()).toEqual([...REVIEWED_MIGRATION_FILES]);
  });

  it('local directory: wrong file name, unknown file and missing file are rejected', () => {
    const exact = [...REVIEWED_MIGRATION_FILES];
    for (const [i, f] of exact.entries()) {
      const renamed = exact.map((x, j) => (j === i ? `${v(f)}_renamed.sql` : x));
      expect(() => assertLocalMigrationFiles(renamed), f).toThrow(new RegExp(`version of the reviewed ${f} but a different file name`));
      const missing = exact.filter((x) => x !== f);
      expect(() => assertLocalMigrationFiles(missing), f).toThrow(new RegExp(`${f} is missing in supabase/migrations`));
    }
    expect(() => assertLocalMigrationFiles([...exact, `${EXTRA}_new.sql`])).toThrow(/is not a reviewed migration file/);
    expect(() => assertLocalMigrationFiles([...exact, 'README.md'])).toThrow(/is not a reviewed migration file/);
    expect(() => assertLocalMigrationFiles([...exact, `${A_FILES[0]!}.bak`])).toThrow(/different file name/);
  });
});

describe('production migration gate: accepted states', () => {
  it('baseline fixture, 3A, 3B and 4A wholly pending → apply 3A,3B,4A; dry-run must be all 10 files in order', () => {
    expect(decideProductionMigrationPlan(production, dryRunFiles([...A_FILES, ...B_FILES, ...C_FILES]))).toEqual(
      apply(['3A', '3B', '4A'], [...A_FILES, ...B_FILES, ...C_FILES]),
    );
    expect(() => assertReleaseApplied(production)).toThrow(new RegExp(`still pending: ${[...A, ...B, ...C].join(', ')}$`));
  });

  it('baseline fixture: the gate never accepts a plan for one stage alone, because db push would apply all 10', () => {
    expect(() => decideProductionMigrationPlan(production, dryRun(A))).toThrow(/differs from expected stages 3A, 3B, 4A/);
    expect(() => decideProductionMigrationPlan(production, dryRun(B))).toThrow(/differs from expected stages 3A, 3B, 4A/);
    expect(() => decideProductionMigrationPlan(production, dryRun([...A, ...B]))).toThrow(/differs from expected stages 3A, 3B, 4A/);
  });

  it('3A wholly applied, 3B and 4A wholly pending → apply 3B,4A; verify-applied still fails', () => {
    expect(decideProductionMigrationPlan(afterA, dryRunFiles([...B_FILES, ...C_FILES]))).toEqual(apply(['3B', '4A'], [...B_FILES, ...C_FILES]));
    expect(() => decideProductionMigrationPlan(afterA, dryRun(B))).toThrow(/differs from expected stages 3B, 4A/);
    expect(() => decideProductionMigrationPlan(afterA, dryRun([...A, ...B, ...C]))).toThrow(/differs from expected stages 3B, 4A/);
    expect(() => decideProductionMigrationPlan(afterA, dryRun([]))).toThrow(/dry-run plan none/);
    expect(() => assertReleaseApplied(afterA)).toThrow(new RegExp(`still pending: ${[...B, ...C].join(', ')}$`));
  });

  it('3A and 3B wholly applied, 4A pending → apply 4A only; verify-applied still fails', () => {
    expect(decideProductionMigrationPlan(afterB, dryRunFiles(C_FILES))).toEqual(apply(['4A'], C_FILES));
    expect(() => decideProductionMigrationPlan(afterB, dryRun([...B, ...C]))).toThrow(/differs from expected stages 4A/);
    expect(() => decideProductionMigrationPlan(afterB, dryRun([]))).toThrow(/dry-run plan none/);
    expect(() => assertReleaseApplied(afterB)).toThrow(new RegExp(`still pending: ${C.join(', ')}$`));
  });

  it('every stage wholly applied → skip, and verify-applied confirms', () => {
    expect(decideProductionMigrationPlan(allApplied, dryRun([]))).toEqual({ mode: 'skip', stages: [], files: [] });
    expect(() => assertReleaseApplied(allApplied)).not.toThrow();
    expect(() => decideProductionMigrationPlan(allApplied, dryRun([B[3]!]))).toThrow(/history shows everything applied but dry-run plans/);
    expect(() => decideProductionMigrationPlan(allApplied, dryRun(C))).toThrow(/history shows everything applied but dry-run plans/);
  });

  it('exhaustive: over every subset of the 10 stage migrations only the four whole-stage states are accepted', () => {
    const stageVersions = [...A, ...B, ...C];
    const accepted: string[] = [];
    for (let mask = 0; mask < 1 << stageVersions.length; mask++) {
      const done = stageVersions.filter((_, i) => mask & (1 << i));
      const rest = stageVersions.filter((x) => !done.includes(x));
      let decision: string;
      try {
        decision = decideProductionMigrationPlan(history([...BASE, ...done]), dryRun(rest)).mode;
      } catch {
        decision = 'rejected';
      }
      if (decision !== 'rejected') accepted.push(`${done.length}:${decision}`);
      let verified = true;
      try {
        assertReleaseApplied(history([...BASE, ...done]));
      } catch {
        verified = false;
      }
      expect(verified, `mask ${mask}`).toBe(done.length === stageVersions.length);
    }
    expect(accepted).toEqual(['0:apply', '5:apply', '9:apply', '10:skip']);
  });
});

describe('production migration gate: rejected states', () => {
  it('partially applied 3A is rejected by plan and verify-applied', () => {
    for (let k = 1; k < A.length; k++) {
      const state = history([...BASE, ...A.slice(0, k)]);
      expect(() => decideProductionMigrationPlan(state, dryRun([...A.slice(k), ...B])), `k=${k}`).toThrow(/partially applied stage 3A/);
      expect(() => assertReleaseApplied(state), `k=${k}`).toThrow(/partially applied stage 3A/);
    }
  });

  it('partially applied 3B is rejected by plan and verify-applied', () => {
    for (let k = 1; k < B.length; k++) {
      const state = history([...BASE, ...A, ...B.slice(0, k)]);
      expect(() => decideProductionMigrationPlan(state, dryRun(B.slice(k))), `k=${k}`).toThrow(/partially applied stage 3B/);
      expect(() => assertReleaseApplied(state), `k=${k}`).toThrow(/partially applied stage 3B/);
    }
    // 3A partial together with 3B partial: still a partial 3A first.
    expect(() => decideProductionMigrationPlan(history([...BASE, A[0]!, B[0]!]), dryRun([]))).toThrow(/partially applied stage 3A/);
  });

  it('3B applied before 3A is rejected', () => {
    const state = history([...BASE, ...B]);
    expect(() => decideProductionMigrationPlan(state, dryRun(A))).toThrow(/stage 3B is applied but the earlier stage 3A is not \(out of order\)/);
    expect(() => assertReleaseApplied(state)).toThrow(/out of order/);
  });

  it('4A applied before 3B (or before 3A) is rejected', () => {
    const skipB = history([...BASE, ...A, ...C]);
    expect(() => decideProductionMigrationPlan(skipB, dryRun(B))).toThrow(/stage 4A is applied but the earlier stage 3B is not \(out of order\)/);
    expect(() => assertReleaseApplied(skipB)).toThrow(/out of order/);
    const onlyC = history([...BASE, ...C]);
    expect(() => decideProductionMigrationPlan(onlyC, dryRun([...A, ...B]))).toThrow(/stage 4A is applied but the earlier stage 3A, 3B is not \(out of order\)/);
  });

  it('a gap inside a stage (a middle migration pending, its neighbours applied) is rejected', () => {
    const gapA = history([...BASE, ...A.filter((_, i) => i !== 2)]);
    expect(() => decideProductionMigrationPlan(gapA, dryRun([A[2]!, ...B]))).toThrow(/partially applied stage 3A/);
    const gapB = history([...BASE, ...A, ...B.filter((_, i) => i !== 1)]);
    expect(() => decideProductionMigrationPlan(gapB, dryRun([B[1]!]))).toThrow(/partially applied stage 3B/);
    expect(() => assertReleaseApplied(gapB)).toThrow(/partially applied stage 3B/);
  });

  it('a migration missing from a stage (no local row in the history) is rejected', () => {
    for (const x of [...A, ...B, ...C]) {
      const rows = ALL.filter((y) => y !== x).map((y) => (BASE.includes(y) ? applied(y) : pending(y)));
      const plan = [...A, ...B, ...C].filter((y) => y !== x);
      expect(() => decideProductionMigrationPlan(list(rows), dryRun(plan)), x).toThrow(new RegExp(`reviewed migration ${x} is missing locally`));
    }
    for (const x of BASE) {
      const rows = ALL.filter((y) => y !== x).map((y) => (BASE.includes(y) ? applied(y) : pending(y)));
      expect(() => decideProductionMigrationPlan(list(rows), dryRun([...A, ...B])), x).toThrow(/is missing locally/);
    }
  });

  it('the baseline (incl. 20261026090000 / 20261026100000) must already be applied', () => {
    for (const x of ['20261026090000', '20261026100000', BASE[0]!]) {
      const state = history(BASE.filter((y) => y !== x));
      expect(() => decideProductionMigrationPlan(state, dryRun([x, ...A, ...B])), x).toThrow(new RegExp(`baseline migration ${x} is not applied`));
      expect(() => assertReleaseApplied(state), x).toThrow(/baseline/);
    }
    const old = history(BASE.slice(0, 9)); // state before the 2026-10-26 release
    expect(() => decideProductionMigrationPlan(old, dryRun(ALL.slice(9)))).toThrow(/baseline migration 20261026090000 is not applied/);
    expect(() => decideProductionMigrationPlan(history([]), dryRun(ALL))).toThrow(/baseline/);
  });

  it('unknown migrations are rejected wherever they appear', () => {
    const extraPending = list([...BASE.map(applied), ...A.map(pending), ...B.map(pending), ...C.map(pending), pending(EXTRA)]);
    expect(() => decideProductionMigrationPlan(extraPending, dryRun([...A, ...B, ...C, EXTRA]))).toThrow(new RegExp(`${EXTRA} is not in the reviewed manifest`));
    const extraApplied = list([...ALL.map(applied), applied(EXTRA)]);
    expect(() => decideProductionMigrationPlan(extraApplied, dryRun([]))).toThrow(/unknown migration/);
    expect(() => assertReleaseApplied(extraApplied)).toThrow(/unknown migration/);
    const inside = list([...BASE.map(applied), ...A.map(pending), pending('20261101200000'), ...B.map(pending), ...C.map(pending)]);
    expect(() => decideProductionMigrationPlan(inside, dryRun([...A, '20261101200000', ...B, ...C]))).toThrow(/20261101200000 is not in the reviewed manifest/);
    // Unknown file only in the dry-run (history is fine).
    expect(() => decideProductionMigrationPlan(production, dryRun([...A, ...B, ...C, EXTRA]))).toThrow(/dry-run plan/);
    expect(() => decideProductionMigrationPlan(afterA, dryRun([...B, ...C, EXTRA]))).toThrow(/dry-run plan/);
    expect(() => decideProductionMigrationPlan(afterB, dryRun([...C, EXTRA]))).toThrow(/dry-run plan/);
  });

  it('a dry-run with the right versions but a different file name is rejected', () => {
    const expected = [...A_FILES, ...B_FILES, ...C_FILES];
    for (const [i, f] of expected.entries()) {
      const files = expected.map((x, j) => (j === i ? `${v(f)}_evil.sql` : x));
      expect(() => decideProductionMigrationPlan(production, dryRunFiles(files)), f).toThrow(/dry-run file names/);
    }
    const renamedB = B_FILES.map((x, j) => (j === 0 ? `${v(x)}_platform_admin_MFA.sql` : x));
    expect(() => decideProductionMigrationPlan(afterA, dryRunFiles([...renamedB, ...C_FILES]))).toThrow(/dry-run file names/);
    expect(() => decideProductionMigrationPlan(afterB, dryRunFiles([`${C[0]}_telegram_bot_connection_v2.sql`]))).toThrow(/dry-run file names/);
  });

  it('a dry-run that differs from the pending stages is rejected', () => {
    const ten = [...A, ...B, ...C];
    const swapped = [ten[1]!, ten[0]!, ...ten.slice(2)];
    for (const plan of [[ten[0]!], [...ten].reverse(), swapped, ten.filter((_, i) => i !== 6), [...BASE.slice(-1), ...ten], [...A, ...B], []]) {
      expect(() => decideProductionMigrationPlan(production, dryRun(plan)), plan.join(',')).toThrow(/dry-run plan/);
    }
    expect(() => decideProductionMigrationPlan(afterA, dryRun(B.slice(0, 3)))).toThrow(/dry-run plan/);
  });

  it('an empty dry-run is never enough on its own', () => {
    expect(() => decideProductionMigrationPlan(production, dryRun([]))).toThrow(/dry-run plan none/);
    expect(() => decideProductionMigrationPlan('', dryRun([]))).toThrow(/not JSON/);
    expect(() => decideProductionMigrationPlan(JSON.stringify({ migrations: [] }), dryRun([]))).toThrow(/empty/);
  });

  it('inconsistent remote history is rejected', () => {
    const remoteOnly = list([...BASE.map(applied), ['', '20261029095000'], ...A.map(pending), ...B.map(pending)]);
    expect(() => decideProductionMigrationPlan(remoteOnly, dryRun([...A, ...B]))).toThrow(/not in supabase\/migrations/);
    const mismatch = list([...BASE.map(applied), [A[0]!, '20261030090001'], ...A.slice(1).map(pending), ...B.map(pending)]);
    expect(() => decideProductionMigrationPlan(mismatch, dryRun([...A.slice(1), ...B]))).toThrow(/mismatch/);
    const duplicate = list([...BASE.map(applied), pending(A[0]!), ...A.map(pending), ...B.map(pending)]);
    expect(() => decideProductionMigrationPlan(duplicate, dryRun([...A, ...B]))).toThrow(/twice/);
    const unsorted = list([...BASE.map(applied), ...B.map(pending), ...A.map(pending)]);
    expect(() => decideProductionMigrationPlan(unsorted, dryRun([...A, ...B]))).toThrow(/not in version order/);
    expect(() => assertReleaseApplied(list([...ALL.map(applied), ['', '20261104000000']]))).toThrow(/not in supabase\/migrations/);
  });

  it('CLI errors and unverifiable output stop the gate', () => {
    const cliError = JSON.stringify({ _tag: 'Error', error: { code: 'DbPushMissingLocalError', message: 'Remote migration versions not found in local migrations directory.' } });
    expect(() => decideProductionMigrationPlan(production, cliError)).toThrow(/DbPushMissingLocalError/);
    expect(() => decideProductionMigrationPlan(cliError, dryRun([...A, ...B]))).toThrow(/reported an error/);
    expect(() => assertReleaseApplied(cliError)).toThrow(/reported an error/);
    expect(() => decideProductionMigrationPlan('Connecting to remote database...', dryRun([...A, ...B]))).toThrow(/not JSON/);
    expect(() => decideProductionMigrationPlan(production, 'Would push these migrations:\n • 20261030090000_a.sql')).toThrow(/not JSON/);
  });
});

describe('strict CLI JSON parsing', () => {
  it('parses the real CLI shapes', () => {
    expect(parseMigrationList(list([applied(BASE[0]!), pending(A[0]!), ['', '20261029095000']]))).toEqual([
      { local: BASE[0], remote: BASE[0] },
      { local: A[0], remote: '' },
      { local: '', remote: '20261029095000' },
    ]);
    expect(parseDryRun(dryRun([...A, ...B]))).toEqual({ upToDate: false, versions: [...A, ...B], files: [...A_FILES, ...B_FILES] });
    expect(parseDryRun(dryRun([]))).toEqual({ upToDate: true, versions: [], files: [] });
  });

  it('rejects malformed rows, versions and plans', () => {
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: 20261014090000, remote: '' }] }))).toThrow(/malformed/);
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: '2026', remote: '' }] }))).toThrow(/invalid version/);
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: '', remote: '' }] }))).toThrow(/empty/);
    expect(() => parseMigrationList('[]')).toThrow(/not a JSON object/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: false, migrations: [A_FILES[0]] }))).toThrow(/not marked as a dry run/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: 'yes', dryRun: true, migrations: [] }))).toThrow(/upToDate/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: true, migrations: ['../evil.sql'] }))).toThrow(/unrecognised/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: true, dryRun: true, migrations: [A_FILES[0]] }))).toThrow(/both up to date/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: true, migrations: [] }))).toThrow(/plans nothing/);
  });
});

describe('check-production-migration-plan.ts (as run by supabase-deploy.yml)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-gate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const file = (content: string) => {
    const path = join(dir, `${n++}.json`);
    writeFileSync(path, content);
    return path;
  };
  const run = (...args: string[]) => {
    const out = join(dir, `out-${n++}.txt`);
    writeFileSync(out, '');
    const r = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/check-production-migration-plan.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(out, 'utf8') };
  };

  it('plan: apply 3A,3B,4A on the baseline fixture, 3B,4A after 3A, 4A after 3B, skip when all applied', () => {
    const now = run('plan', file(production), file(dryRun([...A, ...B, ...C])));
    expect(now.status, now.stderr).toBe(0);
    expect(now.output).toBe('mode=apply\nstages=3A,3B,4A\n');
    expect(now.stdout).toContain('apply whole stage(s) 3A,3B,4A — exactly 10 file(s)');

    const next = run('plan', file(afterA), file(dryRun([...B, ...C])));
    expect(next.status, next.stderr).toBe(0);
    expect(next.output).toBe('mode=apply\nstages=3B,4A\n');

    const last = run('plan', file(afterB), file(dryRun(C)));
    expect(last.status, last.stderr).toBe(0);
    expect(last.output).toBe('mode=apply\nstages=4A\n');
    expect(last.stdout).toContain('apply whole stage(s) 4A — exactly 1 file(s): 20261107090000_telegram_bot_connection.sql');

    const skip = run('plan', file(allApplied), file(dryRun([])));
    expect(skip.status, skip.stderr).toBe(0);
    expect(skip.output).toBe('mode=skip\nstages=\n');
  });

  it('plan: a rejected state exits non-zero and writes no mode', () => {
    const r = run('plan', file(history([...BASE, A[0]!])), file(dryRun([...A.slice(1), ...B, ...C])));
    expect(r.status).toBe(1);
    expect(r.output).toBe('');
    expect(r.stderr).toMatch(/partially applied stage 3A[\s\S]*Deployment stopped before any database change/);
  });

  it('plan --expect-stages: the re-check before db push must see exactly the planned stages', () => {
    const ok = run('plan', file(production), file(dryRun([...A, ...B, ...C])), '--expect-stages', '3A,3B,4A');
    expect(ok.status, ok.stderr).toBe(0);
    const changed = run('plan', file(afterA), file(dryRun([...B, ...C])), '--expect-stages', '3A,3B,4A');
    expect(changed.status).toBe(1);
    expect(changed.output).toBe('');
    expect(changed.stderr).toMatch(/state changed since the plan step: expected apply of 3A,3B,4A, now apply 3B,4A/);
    const nowSkip = run('plan', file(allApplied), file(dryRun([])), '--expect-stages', '4A');
    expect(nowSkip.status).toBe(1);
    expect(run('plan', file(production), file(dryRun([...A, ...B, ...C])), '--expect-stages').status).toBe(1);
    expect(run('plan', file(production), file(dryRun([...A, ...B, ...C])), '--bogus', '3A').status).toBe(1);
  });

  it('verify-applied: succeeds only when every stage is wholly applied', () => {
    const ok = run('verify-applied', file(allApplied));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('stages 3A, 3B, 4A applied');
    for (const state of [production, afterA, afterB, history([...BASE, ...A, B[0]!]), history([...BASE, ...B])]) {
      expect(run('verify-applied', file(state)).status).toBe(1);
    }
    expect(run('verify-applied').status).toBe(1);
    expect(run('unknown-command').status).toBe(1);
  });
});
