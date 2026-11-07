/**
 * Production migration gate for `.github/workflows/supabase-deploy.yml`.
 *
 * The decision is taken from TWO independent CLI outputs, both requested with `--agent no --output-format json`
 * (Supabase CLI 2.120.0, pinned by pnpm-lock.yaml):
 *   * `supabase migration list`  → {"migrations":[{"local":"<v>|","remote":"<v>|","time":"…"}], …}
 *   * `supabase db push --dry-run` → {"upToDate":bool,"dryRun":true,"migrations":["<v>_<name>.sql", …], …}
 *     (a history the CLI itself rejects is printed as {"_tag":"Error", …} with a non-zero exit code).
 * plus the file names in `supabase/migrations` (assertLocalMigrationFiles).
 *
 * How the CLI applies: `supabase db push` has NO selector for versions or groups. It applies EVERY local migration
 * that is missing from the remote history, in version order (and, without --include-all, refuses when such a
 * migration is older than the last applied one). `--dry-run` prints exactly that set. Therefore the gate never
 * "chooses" a stage: it derives which whole stages are pending and requires the dry-run to be exactly their files.
 * Whenever several stages are pending, a single `db push` applies them in stage order (3A, then 3B, then 4A); the
 * gate reports that as e.g. `apply 3A,3B,4A`.
 *
 * Reviewed manifest (explicit file names, no patterns, append-only):
 *   * APPLIED_BASELINE_MIGRATION_FILES — reviewed history that must already be applied before any stage
 *     (incl. 20261026090000 / 20261026100000, which belong to the baseline, not to a release stage);
 *   * MIGRATION_STAGES — release stages in order (3A, 3B, then 4A); each is applied only as a whole.
 * The local migration directory and the local column of the history must be exactly this manifest.
 *
 * Accepted states (anything else throws, so the job stops before the database is changed):
 *   * apply — baseline applied; stages are a fully-applied prefix followed by a fully-pending suffix
 *     (pending = [3A, 3B, 4A], [3B, 4A] or [4A]); the dry-run plans exactly the pending stages' file names in order.
 *   * skip  — baseline and all stages confirmed applied in history, and the dry-run independently reports upToDate
 *     with an empty plan. An empty dry-run alone is never enough.
 * Rejected: partially applied stage, a later stage applied before an earlier one, unapplied baseline, unknown or
 * missing migrations (history or directory), wrong file names, remote-only or mismatching history rows, duplicates,
 * unsorted history, a dry-run that differs from the pending stages, CLI errors and unparseable output.
 */
export const APPLIED_BASELINE_MIGRATION_FILES = [
  '20261014090000_core_schema.sql',
  '20261014090100_access_control.sql',
  '20261014090200_order_functions.sql',
  '20261014090300_storage.sql',
  '20261014090400_fix_create_order_locking.sql',
  '20261014090500_fix_theme_validation_nulls.sql',
  '20261017090000_harden_function_privileges.sql',
  '20261025090000_telegram_notifications_and_platform_admin.sql',
  '20261025090100_notification_secret_cleanup.sql',
  // Release 2026-10-26: included in the reviewed baseline, not a release stage.
  '20261026090000_fulfillment_and_demo_lifecycle.sql',
  '20261026100000_admin_catalog_delete.sql',
] as const;

export const MIGRATION_STAGES = [
  {
    id: '3A',
    files: [
      '20261030090000_owner_change_security.sql',
      '20261030090100_checkout_demo_guard_and_limits.sql',
      '20261031090000_handover_reservation.sql',
      '20261101090000_handover_invite_cooldown_and_stale_release.sql',
      '20261101100000_handover_cancel_keeps_live_reservation.sql',
    ],
  },
  {
    id: '3B',
    files: [
      '20261102090000_platform_admin_mfa.sql',
      '20261102090100_stock_status_projection.sql',
      '20261102090200_demo_shop_deletion.sql',
      '20261102090300_platform_admin_mfa_recovery.sql',
    ],
  },
  // Expand: shop's own Telegram bot (tab «Подключение бота»). Additive only — new private tables, service-role RPCs,
  // a trigger on private.shop_transfers; no existing table, row or function changes. 3C stays reserved for the
  // stock-status Contract step (RELEASE.md).
  {
    id: '4A',
    files: ['20261107090000_telegram_bot_connection.sql'],
  },
] as const;

export type StageId = (typeof MIGRATION_STAGES)[number]['id'];

const versionOf = (file: string) => file.slice(0, 14);

/** Every reviewed migration file, in apply order: baseline, then the stages. */
export const REVIEWED_MIGRATION_FILES: readonly string[] = [
  ...APPLIED_BASELINE_MIGRATION_FILES,
  ...MIGRATION_STAGES.flatMap((s) => s.files),
];
export const REVIEWED_MIGRATIONS: readonly string[] = REVIEWED_MIGRATION_FILES.map(versionOf);
const BASELINE_VERSIONS: readonly string[] = APPLIED_BASELINE_MIGRATION_FILES.map(versionOf);

export type MigrationPlan =
  | { mode: 'apply'; stages: StageId[]; files: string[] }
  | { mode: 'skip'; stages: []; files: [] };
export type MigrationPlanMode = MigrationPlan['mode'];
export interface MigrationHistoryRow {
  local: string;
  remote: string;
}
export interface DryRunPlan {
  upToDate: boolean;
  versions: string[];
  files: string[];
}

const VERSION = /^\d{14}$/;
const PLANNED_FILE = /^(\d{14})_[A-Za-z0-9_.-]+\.sql$/;
const REVIEWED_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;

function fail(reason: string): never {
  throw new Error(`Migration gate: ${reason}`);
}

/** Self-check of the manifest; runs at import time so a broken manifest can never produce a decision. */
export function assertManifestValid(files: readonly string[] = REVIEWED_MIGRATION_FILES): void {
  let previous = '';
  for (const file of files) {
    if (!REVIEWED_FILE.test(file)) fail(`manifest entry "${file}" is not an exact <14-digit version>_<name>.sql file name`);
    const v = versionOf(file);
    if (v <= previous) fail(`manifest entry ${file} is not strictly after ${previous}`);
    previous = v;
  }
}
assertManifestValid();

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The directory `supabase/migrations` must contain exactly the reviewed file names — nothing more, nothing less. */
export function assertLocalMigrationFiles(entries: readonly string[]): void {
  const reviewed = new Set(REVIEWED_MIGRATION_FILES);
  const byVersion = new Map(REVIEWED_MIGRATION_FILES.map((f) => [versionOf(f), f]));
  for (const entry of entries) {
    if (reviewed.has(entry)) continue;
    const sameVersion = byVersion.get(versionOf(entry));
    if (sameVersion) fail(`supabase/migrations/${entry} has the version of the reviewed ${sameVersion} but a different file name`);
    fail(`supabase/migrations/${entry} is not a reviewed migration file`);
  }
  const present = new Set(entries);
  for (const file of REVIEWED_MIGRATION_FILES) if (!present.has(file)) fail(`reviewed migration ${file} is missing in supabase/migrations`);
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
  const files: string[] = [];
  const versions = obj.migrations.map((file: unknown) => {
    const m = typeof file === 'string' ? PLANNED_FILE.exec(file) : null;
    if (!m) fail(`dry-run planned an unrecognised entry ${JSON.stringify(file)}`);
    files.push(m[0]);
    return m[1]!;
  });
  if (obj.upToDate && versions.length > 0) fail('dry-run is both up to date and has planned migrations');
  if (!obj.upToDate && versions.length === 0) fail('dry-run is not up to date but plans nothing');
  return { upToDate: obj.upToDate, versions, files };
}

interface HistoryState {
  pending: string[];
  pendingStages: StageId[];
}

/** Consistency rules that hold in every accepted state. Returns the pending versions and the pending stages. */
function checkHistory(rows: MigrationHistoryRow[]): HistoryState {
  const seen = new Set<string>();
  const applied = new Set<string>();
  const pending: string[] = [];
  let previous = '';
  let lastApplied = '';
  for (const { local, remote } of rows) {
    if (local === '') fail(`remote history has ${remote}, which is not in supabase/migrations (inconsistent remote history)`);
    if (remote !== '' && remote !== local) fail(`history row mismatch: local ${local}, remote ${remote}`);
    if (seen.has(local)) fail(`migration ${local} is listed twice`);
    if (local < previous) fail(`migration list is not in version order (${local} after ${previous})`);
    seen.add(local);
    previous = local;
    if (remote === '') pending.push(local);
    else {
      applied.add(local);
      lastApplied = local;
    }
  }
  // The local column must be exactly the reviewed manifest: no unknown and no missing versions.
  for (const v of seen) if (!REVIEWED_MIGRATIONS.includes(v)) fail(`migration ${v} is not in the reviewed manifest (unknown migration)`);
  for (const v of REVIEWED_MIGRATIONS) if (!seen.has(v)) fail(`reviewed migration ${v} is missing locally`);

  for (const v of BASELINE_VERSIONS) if (!applied.has(v)) fail(`baseline migration ${v} is not applied in the remote history`);

  const pendingStages: StageId[] = [];
  for (const stage of MIGRATION_STAGES) {
    const versions = stage.files.map(versionOf);
    const done = versions.filter((v) => applied.has(v));
    if (done.length > 0 && done.length < versions.length) {
      const rest = versions.filter((v) => !applied.has(v));
      fail(`partially applied stage ${stage.id}: ${done.join(', ')} applied, pending ${rest.join(', ')}`);
    }
    if (done.length === 0) pendingStages.push(stage.id);
    else if (pendingStages.length > 0) {
      fail(`stage ${stage.id} is applied but the earlier stage ${pendingStages.join(', ')} is not (out of order)`);
    }
  }

  const firstPending = pending[0];
  if (firstPending !== undefined && lastApplied > firstPending) {
    fail(`pending migration ${firstPending} is older than the applied ${lastApplied} (out of order)`);
  }
  // Defensive: the pending history must be exactly the pending stages (holds by construction of the checks above).
  const expected = stageFiles(pendingStages).map(versionOf);
  if (!same(pending, expected)) fail(`pending migrations ${pending.join(', ')} are not exactly the stages ${pendingStages.join(', ')}`);
  return { pending, pendingStages };
}

function stageFiles(stages: readonly StageId[]): string[] {
  return MIGRATION_STAGES.filter((s) => stages.includes(s.id)).flatMap((s) => [...s.files]);
}

/** Decide whether the deploy may push the pending whole stages ('apply') or skip db push ('skip'); otherwise throws. */
export function decideProductionMigrationPlan(migrationListJson: string, dryRunJson: string): MigrationPlan {
  const { pendingStages } = checkHistory(parseMigrationList(migrationListJson));
  const plan = parseDryRun(dryRunJson);

  if (pendingStages.length === 0) {
    if (!plan.upToDate) fail(`history shows everything applied but dry-run plans ${plan.versions.join(', ')}`);
    return { mode: 'skip', stages: [], files: [] };
  }
  const files = stageFiles(pendingStages);
  const versions = files.map(versionOf);
  if (plan.upToDate || !same(plan.versions, versions)) {
    fail(`dry-run plan ${plan.versions.join(', ') || 'none'} differs from expected stages ${pendingStages.join(', ')}: ${versions.join(', ')}`);
  }
  if (!same(plan.files, files)) {
    fail(`dry-run file names ${plan.files.join(', ')} differ from the reviewed ${files.join(', ')}`);
  }
  return { mode: 'apply', stages: pendingStages, files };
}

/** After `db push` (or on skip): baseline and every stage must be confirmed applied, nothing pending. */
export function assertReleaseApplied(migrationListJson: string): void {
  const { pending } = checkHistory(parseMigrationList(migrationListJson));
  if (pending.length > 0) fail(`after push these migrations are still pending: ${pending.join(', ')}`);
}
