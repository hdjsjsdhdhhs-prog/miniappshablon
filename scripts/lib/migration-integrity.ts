/**
 * SHA-256 integrity of the reviewed migrations, checked by the production gate before the plan, again right before
 * `db push`, and on verify-applied (scripts/check-production-migration-plan.ts), and by `pnpm check:migration-integrity`.
 *
 * Expected names come from the gate manifest (REVIEWED_MIGRATION_FILES = APPLIED_BASELINE_MIGRATION_FILES +
 * MIGRATION_STAGES); expected hashes from the static MIGRATION_INTEGRITY_MANIFEST. Every call re-reads every file
 * from disk: there is no cache, so a file changed after the plan is caught by the re-check before the push.
 *
 * Canonical content (identical on Windows and Linux checkouts, never "repaired"):
 *   1. the bytes must be valid UTF-8 (otherwise: error);
 *   2. every CRLF becomes LF; a CR that is not followed by LF is an error;
 *   3. nothing else changes — BOM, spaces, tabs, blank lines, comments and SQL are hashed exactly as they are.
 * SHA-256 is taken over those canonical bytes (lowercase hex).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_INTEGRITY_MANIFEST, type MigrationIntegrityEntry } from './migration-integrity-manifest.ts';
import { assertLocalMigrationFiles, REVIEWED_MIGRATION_FILES } from './migration-plan.ts';

/** `supabase/migrations` of this repository, resolved from this file — never from process.cwd(). */
export const DEFAULT_MIGRATIONS_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'supabase', 'migrations');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CR = 0x0d;
const LF = 0x0a;

function fail(reason: string): never {
  throw new Error(`Migration integrity: ${reason}`);
}

// fatal: invalid UTF-8 throws instead of becoming U+FFFD; ignoreBOM: a BOM is content, not silently skipped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Canonical bytes of a migration: validated UTF-8 with CRLF → LF; bare CR is rejected; nothing else is touched. */
export function canonicalMigrationBytes(raw: Uint8Array, label = 'content'): Buffer {
  try {
    utf8.decode(raw);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  // Byte-level is exact: in UTF-8 the byte 0x0D only ever encodes CR (continuation bytes are 0x80–0xBF).
  const out = Buffer.allocUnsafe(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i]!;
    if (byte === CR) {
      if (raw[i + 1] !== LF) fail(`${label} has a bare CR (not followed by LF) at byte offset ${i}`);
      continue; // drop the CR of a CRLF pair; its LF is copied on the next iteration
    }
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/** SHA-256 (lowercase hex) of the canonical migration bytes. */
export function canonicalSha256(raw: Uint8Array, label?: string): string {
  return createHash('sha256').update(canonicalMigrationBytes(raw, label)).digest('hex');
}

/**
 * The integrity manifest must cover exactly the reviewed migrations of the gate manifest, in the same order, once
 * each, with well-formed hashes. Returns the approved hash per file name.
 */
export function assertIntegrityManifestValid(
  manifest: readonly MigrationIntegrityEntry[] = MIGRATION_INTEGRITY_MANIFEST,
  reviewed: readonly string[] = REVIEWED_MIGRATION_FILES,
): ReadonlyMap<string, string> {
  const approved = new Map<string, string>();
  for (const [i, entry] of manifest.entries()) {
    const { file, sha256 } = (entry ?? {}) as Partial<MigrationIntegrityEntry>;
    if (typeof file !== 'string' || typeof sha256 !== 'string') fail(`manifest entry ${i} is malformed`);
    if (approved.has(file)) fail(`manifest lists ${file} twice`);
    if (!reviewed.includes(file)) fail(`manifest entry ${file} is not a reviewed migration (APPLIED_BASELINE_MIGRATION_FILES / MIGRATION_STAGES)`);
    if (!SHA256_HEX.test(sha256)) fail(`manifest hash of ${file} is not a SHA-256 of 64 lowercase hex characters`);
    approved.set(file, sha256);
  }
  for (const file of reviewed) if (!approved.has(file)) fail(`reviewed migration ${file} has no approved SHA-256 in the integrity manifest`);
  const order = manifest.map((e) => e.file);
  if (order.some((file, i) => file !== reviewed[i])) fail('manifest order differs from the reviewed migration order');
  return approved;
}

export interface MigrationIntegrityOptions {
  /** Directory to check (tests use temporary copies). Default: this repository's supabase/migrations. */
  migrationsDir?: string;
  /** For tests of the manifest checks only; production code always uses the static manifest. */
  manifest?: readonly MigrationIntegrityEntry[];
}

export interface VerifiedMigration {
  file: string;
  sha256: string;
}

/**
 * Verify that `migrationsDir` holds exactly the reviewed migration files and that the canonical SHA-256 of each one
 * equals its approved hash. Reads every file on every call. Throws on any difference; returns the verified hashes.
 */
export function assertMigrationIntegrity(options: MigrationIntegrityOptions = {}): VerifiedMigration[] {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const approved = assertIntegrityManifestValid(options.manifest ?? MIGRATION_INTEGRITY_MANIFEST);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    fail(`can not read the migrations directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertLocalMigrationFiles(entries); // exact names: no missing, extra or renamed files

  const mismatches: string[] = [];
  const verified = REVIEWED_MIGRATION_FILES.map((file) => {
    const path = join(dir, file);
    if (!lstatSync(path).isFile()) fail(`${file} is not a regular file`);
    const sha256 = canonicalSha256(readFileSync(path), file);
    const expected = approved.get(file)!;
    if (sha256 !== expected) mismatches.push(`${file}: approved ${expected}, actual ${sha256}`);
    return { file, sha256 };
  });
  if (mismatches.length > 0) {
    fail(`content differs from the approved SHA-256 in ${mismatches.length} file(s):\n  ${mismatches.join('\n  ')}`);
  }
  return verified;
}
