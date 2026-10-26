export const EXPECTED_PRODUCTION_MIGRATIONS = ['20261025090000', '20261025090100'] as const;

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
