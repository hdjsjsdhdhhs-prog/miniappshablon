import { describe, expect, it } from 'vitest';
import { assertExpectedProductionMigrationPlan, EXPECTED_PRODUCTION_MIGRATIONS, migrationPlanVersions } from './migration-plan';

describe('Supabase CLI migration plan parsing', () => {
  it('expects exactly the two migrations of this release, in order', () => {
    expect(EXPECTED_PRODUCTION_MIGRATIONS).toEqual(['20261026090000', '20261026100000']);
  });

  it('extracts planned timestamps from the Would push these migrations section in order', () => {
    const output = `Connecting to remote database...\nWould push these migrations:\n • 20261026090000_fulfillment_and_demo_lifecycle.sql\n • 20261026100000_admin_catalog_delete.sql\nFinished supabase db push.`;

    expect(migrationPlanVersions(output)).toEqual(['20261026090000', '20261026100000']);
    expect(() => assertExpectedProductionMigrationPlan(output)).not.toThrow();
  });

  it('rejects missing, extra, or out-of-order planned migrations', () => {
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261026090000_first.sql')).toThrow(
      'Unexpected migration plan',
    );
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261026100000_second.sql\n • 20261026090000_first.sql')).toThrow(
      'Unexpected migration plan',
    );
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261026090000_first.sql\n • 20261026100000_second.sql\n • 20261026110000_extra.sql')).toThrow(
      'Unexpected migration plan',
    );
  });

  it('rejects the already-applied previous release and an empty plan', () => {
    // 20261025090000 / 20261025090100 are applied in production: seeing them again means the target is wrong.
    expect(() =>
      assertExpectedProductionMigrationPlan(
        'Would push these migrations:\n • 20261025090000_telegram_notifications_and_platform_admin.sql\n • 20261025090100_notification_secret_cleanup.sql\n • 20261026090000_a.sql\n • 20261026100000_b.sql',
      ),
    ).toThrow('Unexpected migration plan');
    expect(() => assertExpectedProductionMigrationPlan('Remote database is up to date.')).toThrow('got none');
  });

  it('rejects a partially applied release (only the second migration pending)', () => {
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261026100000_admin_catalog_delete.sql')).toThrow(
      'got 20261026100000',
    );
  });

  it('does not treat unrelated timestamps elsewhere in CLI output as planned migrations', () => {
    expect(migrationPlanVersions('Applying 20261025090000 from history\nNo migrations to push')).toEqual([]);
  });
});
