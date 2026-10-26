import { describe, expect, it } from 'vitest';
import { assertExpectedProductionMigrationPlan, migrationPlanVersions } from './migration-plan';

describe('Supabase CLI migration plan parsing', () => {
  it('extracts planned timestamps from the Would push these migrations section in order', () => {
    const output = `Connecting to remote database...\nWould push these migrations:\n • 20261025090000_telegram_notifications_and_platform_admin.sql\n • 20261025090100_notification_secret_cleanup.sql\nFinished supabase db push.`;

    expect(migrationPlanVersions(output)).toEqual(['20261025090000', '20261025090100']);
    expect(() => assertExpectedProductionMigrationPlan(output)).not.toThrow();
  });

  it('rejects missing, extra, or out-of-order planned migrations', () => {
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261025090000_first.sql')).toThrow(
      'Unexpected migration plan',
    );
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261025090100_second.sql\n • 20261025090000_first.sql')).toThrow(
      'Unexpected migration plan',
    );
    expect(() => assertExpectedProductionMigrationPlan('Would push these migrations:\n • 20261025090000_first.sql\n • 20261025090100_second.sql\n • 20261025090200_extra.sql')).toThrow(
      'Unexpected migration plan',
    );
  });

  it('does not treat unrelated timestamps elsewhere in CLI output as planned migrations', () => {
    expect(migrationPlanVersions('Applying 20261025090000 from history\nNo migrations to push')).toEqual([]);
  });
});
