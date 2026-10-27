/**
 * The exact, reviewed plan of the next production `supabase db push` (order matters). 20261025090000 and
 * 20261025090100 are already applied in production; this release (stage 1 of the fulfillment release) adds only
 * backward-compatible changes. Update this list for every release — a dry-run that differs stops the deploy.
 *
 * Expected behaviour of the deploy workflow with this list (intentionally strict, no "nothing to do" shortcut):
 *   * First run (both pending): the dry-run lists 20261026090000, 20261026100000 → accepted → db push → functions.
 *   * Later runs (both applied): the dry-run lists nothing → rejected ("got none"); the job stops before db push and
 *     before any Edge Function deploy. Re-deploying functions alone needs a reviewed change of this list.
 *   * Partial state (only 20261026100000 pending) or any extra / reordered / previously-applied version → rejected.
 */
export const EXPECTED_PRODUCTION_MIGRATIONS = ['20261026090000', '20261026100000'] as const;

/** Extract migration versions only from the CLI's planned filenames, preserving their order. */
export function migrationPlanVersions(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*Would push these migrations\s*:?\s*$/i.test(line));
  if (headerIndex < 0) return [];

  const versions: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const filename = line.match(/^\s*(?:[-*•]\s*)?(\d{14})_[^\r\n]+\.sql\s*$/);
    if (filename) {
      versions.push(filename[1]!);
      continue;
    }
    if (versions.length > 0 || line.trim() !== '') break;
  }
  return versions;
}

export function assertExpectedProductionMigrationPlan(output: string): void {
  const actual = migrationPlanVersions(output);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_PRODUCTION_MIGRATIONS)) {
    throw new Error(
      `Unexpected migration plan: expected ${EXPECTED_PRODUCTION_MIGRATIONS.join(', ')}, got ${actual.join(', ') || 'none'}`,
    );
  }
}
