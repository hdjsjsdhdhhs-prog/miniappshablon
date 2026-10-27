import { describe, expect, it } from 'vitest';
import { assertReleaseApplied, decideProductionMigrationPlan, EXPECTED_PRODUCTION_MIGRATIONS, parseDryRun, parseMigrationList } from './migration-plan';

// Fixtures follow the real JSON of Supabase CLI 2.120.0 (`--agent no --output-format json`).
const BEFORE = ['20261014090000', '20261017090000', '20261025090000', '20261025090100'];
const FILES: Record<string, string> = {
  '20261026090000': '20261026090000_fulfillment_and_demo_lifecycle.sql',
  '20261026100000': '20261026100000_admin_catalog_delete.sql',
  '20261026110000': '20261026110000_extra.sql',
};

type Row = [local: string, remote: string];
const applied = (v: string): Row => [v, v];
const pending = (v: string): Row => [v, ''];
const list = (rows: Row[]) => JSON.stringify({ migrations: rows.map(([local, remote]) => ({ local, remote, time: '2026-10-26 09:00:00' })), message: 'Migrations listed' });
const dryRun = (versions: string[]) =>
  JSON.stringify({
    upToDate: versions.length === 0,
    dryRun: true,
    migrations: versions.map((v) => FILES[v] ?? `${v}_x.sql`),
    seeds: [],
    roles: [],
    message: versions.length === 0 ? 'Remote database is up to date.' : 'Finished supabase db push.',
  });

const [M1, M2] = EXPECTED_PRODUCTION_MIGRATIONS;
const firstRunList = list([...BEFORE.map(applied), pending(M1), pending(M2)]);
const appliedList = list([...BEFORE.map(applied), applied(M1), applied(M2)]);

describe('production migration gate', () => {
  it('expects exactly the two migrations of this release, in order', () => {
    expect(EXPECTED_PRODUCTION_MIGRATIONS).toEqual(['20261026090000', '20261026100000']);
  });

  it('first run: both pending in history and the exact dry-run plan → apply', () => {
    expect(decideProductionMigrationPlan(firstRunList, dryRun([M1, M2]))).toBe('apply');
  });

  it('first run: a dry-run that differs from the confirmed pending history is rejected', () => {
    for (const plan of [[M1], [M2, M1], [M1, M2, '20261026110000'], []]) {
      expect(() => decideProductionMigrationPlan(firstRunList, dryRun(plan)), plan.join(',')).toThrow(/dry-run plan/);
    }
  });

  it('repeat run: both confirmed applied in history and dry-run up to date → skip', () => {
    expect(decideProductionMigrationPlan(appliedList, dryRun([]))).toBe('skip');
    expect(() => assertReleaseApplied(appliedList)).not.toThrow();
  });

  it('an empty dry-run is never enough on its own', () => {
    // History still shows the release pending (or cannot be read): an up-to-date dry-run must not lead to skip.
    expect(() => decideProductionMigrationPlan(firstRunList, dryRun([]))).toThrow(/dry-run plan none/);
    expect(() => decideProductionMigrationPlan('', dryRun([]))).toThrow(/not JSON/);
    expect(() => decideProductionMigrationPlan(JSON.stringify({ migrations: [] }), dryRun([]))).toThrow(/empty/);
    // History says applied but the dry-run still wants to push something → inconsistent.
    expect(() => decideProductionMigrationPlan(appliedList, dryRun([M2]))).toThrow(/dry-run plans/);
  });

  it('partial application is rejected in both directions', () => {
    expect(() => decideProductionMigrationPlan(list([...BEFORE.map(applied), applied(M1), pending(M2)]), dryRun([M2]))).toThrow(/partially applied/);
    // Second applied without the first: also caught as out of order.
    expect(() => decideProductionMigrationPlan(list([...BEFORE.map(applied), pending(M1), applied(M2)]), dryRun([M1]))).toThrow(/out of order/);
    expect(() => assertReleaseApplied(list([...BEFORE.map(applied), applied(M1), pending(M2)]))).toThrow(/still pending: 20261026100000/);
  });

  it('extra pending migrations are rejected, before or after the release', () => {
    const extraAfter = list([...BEFORE.map(applied), pending(M1), pending(M2), pending('20261026110000')]);
    expect(() => decideProductionMigrationPlan(extraAfter, dryRun([M1, M2, '20261026110000']))).toThrow(/unexpected pending/);
    const extraAfterApplied = list([...BEFORE.map(applied), applied(M1), applied(M2), pending('20261026110000')]);
    expect(() => decideProductionMigrationPlan(extraAfterApplied, dryRun(['20261026110000']))).toThrow(/unexpected pending/);
    // A previous release that is not applied means a wrong / fresh target.
    const fresh = list([...BEFORE.map(pending), pending(M1), pending(M2)]);
    expect(() => decideProductionMigrationPlan(fresh, dryRun([...BEFORE, M1, M2]))).toThrow(/unexpected pending/);
  });

  it('inconsistent remote history is rejected', () => {
    const remoteOnly = list([...BEFORE.map(applied), ['', '20261026095000'], pending(M1), pending(M2)]);
    expect(() => decideProductionMigrationPlan(remoteOnly, dryRun([M1, M2]))).toThrow(/not in supabase\/migrations/);
    const mismatch = list([...BEFORE.map(applied), ['20261026090000', '20261026090001'], pending(M2)]);
    expect(() => decideProductionMigrationPlan(mismatch, dryRun([M2]))).toThrow(/mismatch/);
    const duplicate = list([...BEFORE.map(applied), pending(M1), pending(M1), pending(M2)]);
    expect(() => decideProductionMigrationPlan(duplicate, dryRun([M1, M2]))).toThrow(/twice/);
    const missingFile = list([...BEFORE.map(applied), pending(M1)]);
    expect(() => decideProductionMigrationPlan(missingFile, dryRun([M1]))).toThrow(/missing locally/);
    expect(() => assertReleaseApplied(list([...BEFORE.map(applied), applied(M1), applied(M2), ['', '20261027000000']]))).toThrow(/not in supabase\/migrations/);
  });

  it('CLI errors and unverifiable output stop the gate', () => {
    const cliError = JSON.stringify({ _tag: 'Error', error: { code: 'DbPushMissingLocalError', message: 'Remote migration versions not found in local migrations directory.' } });
    expect(() => decideProductionMigrationPlan(firstRunList, cliError)).toThrow(/DbPushMissingLocalError/);
    expect(() => decideProductionMigrationPlan(cliError, dryRun([M1, M2]))).toThrow(/reported an error/);
    expect(() => decideProductionMigrationPlan('Connecting to remote database...', dryRun([M1, M2]))).toThrow(/not JSON/);
    expect(() => decideProductionMigrationPlan(firstRunList, 'Would push these migrations:\n • 20261026090000_a.sql')).toThrow(/not JSON/);
  });
});

describe('strict CLI JSON parsing', () => {
  it('parses the real CLI shapes', () => {
    expect(parseMigrationList(list([applied('20261014090000'), pending(M1), ['', '20261026095000']]))).toEqual([
      { local: '20261014090000', remote: '20261014090000' },
      { local: M1, remote: '' },
      { local: '', remote: '20261026095000' },
    ]);
    expect(parseDryRun(dryRun([M1, M2]))).toEqual({ upToDate: false, versions: [M1, M2] });
    expect(parseDryRun(dryRun([]))).toEqual({ upToDate: true, versions: [] });
  });

  it('rejects malformed rows, versions and plans', () => {
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: 20261014090000, remote: '' }] }))).toThrow(/malformed/);
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: '2026', remote: '' }] }))).toThrow(/invalid version/);
    expect(() => parseMigrationList(JSON.stringify({ migrations: [{ local: '', remote: '' }] }))).toThrow(/empty/);
    expect(() => parseMigrationList('[]')).toThrow(/not a JSON object/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: false, migrations: [FILES[M1]] }))).toThrow(/not marked as a dry run/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: 'yes', dryRun: true, migrations: [] }))).toThrow(/upToDate/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: true, migrations: ['../evil.sql'] }))).toThrow(/unrecognised/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: true, dryRun: true, migrations: [FILES[M1]] }))).toThrow(/both up to date/);
    expect(() => parseDryRun(JSON.stringify({ upToDate: false, dryRun: true, migrations: [] }))).toThrow(/plans nothing/);
  });
});
