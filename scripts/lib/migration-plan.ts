/**
 * Production migration gate for `.github/workflows/supabase-deploy.yml`.
 *
 * The decision is taken from TWO independent CLI outputs, both requested with `--agent no --output-format json`
 * (Supabase CLI 2.120.0, pinned by pnpm-lock.yaml):
 *   * `supabase migration list`  → {"migrations":[{"local":"<v>|","remote":"<v>|","time":"…"}], …}
 *   * `supabase db push --dry-run` → {"upToDate":bool,"dryRun":true,"migrations":["<v>_<name>.sql", …], …}
 *     (a history the CLI itself rejects is printed as {"_tag":"Error", …} with a non-zero exit code).
 *
 * Accepted states (anything else throws, so the job stops before the database is changed):
 *   * apply — every migration before this release is applied, both release migrations are pending in the history,
 *     nothing else is pending, and the dry-run plans exactly EXPECTED_PRODUCTION_MIGRATIONS in this order.
 *   * skip  — the history confirms every local migration (including both release migrations) as applied, has no
 *     remote-only or mismatching rows, and the dry-run independently reports upToDate with an empty plan.
 *     An empty dry-run alone is never enough: without the confirmed history the gate fails.
 * Rejected: partial release, extra/unknown pending migrations, wrong order, remote-only or mismatching history rows,
 * a missing release file, CLI errors and any output that can not be parsed (state can not be verified).
 *
 * Update EXPECTED_PRODUCTION_MIGRATIONS (reviewed) for every release that adds migrations.
 */
export const EXPECTED_PRODUCTION_MIGRATIONS = ['20261026090000', '20261026100000'] as const;

export type MigrationPlanMode = 'apply' | 'skip';
export interface MigrationHistoryRow {
  local: string;
  remote: string;
}
export interface DryRunPlan {
  upToDate: boolean;
  versions: string[];
}

const VERSION = /^\d{14}$/;
const PLANNED_FILE = /^(\d{14})_[A-Za-z0-9_.-]+\.sql$/;

function fail(reason: string): never {
  throw new Error(`Migration gate: ${reason}`);
}

function parseJson(raw: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    fail(`${what} output is not JSON, state can not be verified`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what} output is not a JSON object`);
  const obj = value as Record<string, unknown>;
  if ('_tag' in obj || 'error' in obj) fail(`${what} reported an error: ${JSON.stringify(obj.error ?? obj)}`);
  return obj;
}

/** Strictly parse `supabase migration list --output-format json`. */
export function parseMigrationList(raw: string): MigrationHistoryRow[] {
  const obj = parseJson(raw, 'migration list');
  if (!Array.isArray(obj.migrations)) fail('migration list has no "migrations" array');
  if (obj.migrations.length === 0) fail('migration list is empty, wrong target or history can not be read');
  return obj.migrations.map((row: unknown, i: number) => {
    const r = row as Record<string, unknown> | null;
    const local = r?.local;
    const remote = r?.remote;
    if (typeof local !== 'string' || typeof remote !== 'string') fail(`migration list row ${i} is malformed`);
    for (const v of [local, remote]) if (v !== '' && !VERSION.test(v)) fail(`migration list row ${i} has an invalid version "${v}"`);
    if (local === '' && remote === '') fail(`migration list row ${i} is empty`);
    return { local, remote };
  });
}

/** Strictly parse `supabase db push --dry-run --output-format json`. */
export function parseDryRun(raw: string): DryRunPlan {
  const obj = parseJson(raw, 'dry-run');
  if (obj.dryRun !== true) fail('dry-run output is not marked as a dry run');
  if (typeof obj.upToDate !== 'boolean') fail('dry-run output has no boolean "upToDate"');
  if (!Array.isArray(obj.migrations)) fail('dry-run output has no "migrations" array');
  const versions = obj.migrations.map((file: unknown) => {
    const m = typeof file === 'string' ? PLANNED_FILE.exec(file) : null;
    if (!m) fail(`dry-run planned an unrecognised entry ${JSON.stringify(file)}`);
    return m[1]!;
  });
  if (obj.upToDate && versions.length > 0) fail('dry-run is both up to date and has planned migrations');
  if (!obj.upToDate && versions.length === 0) fail('dry-run is not up to date but plans nothing');
  return { upToDate: obj.upToDate, versions };
}

/** Consistency rules that hold in every accepted state. Returns the pending (local-only) versions in order. */
function checkHistory(rows: MigrationHistoryRow[]): string[] {
  const seen = new Set<string>();
  const pending: string[] = [];
  let lastApplied = '';
  for (const { local, remote } of rows) {
    if (local === '') fail(`remote history has ${remote}, which is not in supabase/migrations (inconsistent remote history)`);
    if (remote !== '' && remote !== local) fail(`history row mismatch: local ${local}, remote ${remote}`);
    if (seen.has(local)) fail(`migration ${local} is listed twice`);
    seen.add(local);
    if (remote === '') pending.push(local);
    else lastApplied = local;
  }
  for (const v of EXPECTED_PRODUCTION_MIGRATIONS) if (!seen.has(v)) fail(`release migration ${v} is missing locally`);
  const firstPending = pending[0];
  if (firstPending !== undefined && lastApplied > firstPending) {
    fail(`pending migration ${firstPending} is older than the applied ${lastApplied} (out of order)`);
  }
  return pending;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Decide whether the deploy may push the release migrations ('apply') or skip db push ('skip'); otherwise throws. */
export function decideProductionMigrationPlan(migrationListJson: string, dryRunJson: string): MigrationPlanMode {
  const pending = checkHistory(parseMigrationList(migrationListJson));
  const plan = parseDryRun(dryRunJson);
  const expected = EXPECTED_PRODUCTION_MIGRATIONS;

  if (pending.length === 0) {
    if (!plan.upToDate) fail(`history shows everything applied but dry-run plans ${plan.versions.join(', ')}`);
    return 'skip';
  }
  if (!same(pending, expected)) {
    const applied = expected.filter((v) => !pending.includes(v));
    if (applied.length > 0 && applied.length < expected.length) {
      fail(`partially applied release: ${applied.join(', ')} applied, pending ${pending.join(', ')}`);
    }
    fail(`unexpected pending migrations: expected ${expected.join(', ')}, history has ${pending.join(', ')}`);
  }
  if (plan.upToDate || !same(plan.versions, expected)) {
    fail(`dry-run plan ${plan.versions.join(', ') || 'none'} differs from expected ${expected.join(', ')}`);
  }
  return 'apply';
}

/** After `db push` (or on skip): the history must confirm every local migration, including the release, as applied. */
export function assertReleaseApplied(migrationListJson: string): void {
  const pending = checkHistory(parseMigrationList(migrationListJson));
  if (pending.length > 0) fail(`after push these migrations are still pending: ${pending.join(', ')}`);
}
