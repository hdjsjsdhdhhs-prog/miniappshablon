import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertIntegrityManifestValid,
  assertMigrationIntegrity,
  canonicalMigrationBytes,
  canonicalSha256,
  DEFAULT_MIGRATIONS_DIR,
} from './migration-integrity.ts';
import { MIGRATION_INTEGRITY_MANIFEST, type MigrationIntegrityEntry } from './migration-integrity-manifest.ts';
import { APPLIED_BASELINE_MIGRATION_FILES, MIGRATION_STAGES, REVIEWED_MIGRATION_FILES } from './migration-plan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const BASE_FILE = APPLIED_BASELINE_MIGRATION_FILES[0];
const A_FILE = MIGRATION_STAGES[0].files[0];
const B_FILE = MIGRATION_STAGES[1].files[3];

// Temporary copies only: the real supabase/migrations is read, never written.
const tmpRoot = mkdtempSync(join(tmpdir(), 'migration-integrity-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
type Eol = 'as-is' | 'lf' | 'crlf';
/** Copy the 21 real migrations into a fresh directory, optionally with all line endings forced to LF or CRLF. */
function copyMigrations(eol: Eol = 'as-is'): string {
  const dir = join(tmpRoot, `m${n++}`);
  mkdirSync(dir);
  for (const file of REVIEWED_MIGRATION_FILES) {
    const raw = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file));
    const lf = canonicalMigrationBytes(raw, file);
    const bytes = eol === 'as-is' ? raw : eol === 'lf' ? lf : Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    writeFileSync(join(dir, file), bytes);
  }
  return dir;
}
const editText = (dir: string, file: string, change: (s: string) => string) => {
  const before = readFileSync(join(dir, file), 'utf8');
  const after = change(before);
  expect(after, 'the edit must actually change the file').not.toBe(before);
  writeFileSync(join(dir, file), after);
};
const editBytes = (dir: string, file: string, change: (b: Buffer) => Buffer) =>
  writeFileSync(join(dir, file), change(readFileSync(join(dir, file))));
const check = (dir: string, manifest?: readonly MigrationIntegrityEntry[]) => () => assertMigrationIntegrity({ migrationsDir: dir, manifest });
const differs = (file: string) => new RegExp(`content differs from the approved SHA-256 in 1 file\\(s\\):\\n  ${file}: approved [0-9a-f]{64}, actual [0-9a-f]{64}$`);

describe('integrity manifest', () => {
  it('has exactly one well-formed SHA-256 per reviewed migration, in the gate manifest order (11 + 5 + 4 + 1 = 21)', () => {
    expect(MIGRATION_INTEGRITY_MANIFEST).toHaveLength(21);
    expect(MIGRATION_INTEGRITY_MANIFEST.map((e) => e.file)).toEqual([...REVIEWED_MIGRATION_FILES]);
    expect(REVIEWED_MIGRATION_FILES).toEqual([...APPLIED_BASELINE_MIGRATION_FILES, ...MIGRATION_STAGES.flatMap((s) => s.files)]);
    for (const { file, sha256 } of MIGRATION_INTEGRITY_MANIFEST) expect(sha256, file).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(MIGRATION_INTEGRITY_MANIFEST.map((e) => e.sha256)).size).toBe(21);
    expect(() => assertIntegrityManifestValid()).not.toThrow();
  });

  it('is static data: the manifest module reads no files and computes no hashes', () => {
    const source = readFileSync(join(REPO, 'scripts', 'lib', 'migration-integrity-manifest.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/createHash|readFile|readdir|require\(|process\./);
    for (const { sha256 } of MIGRATION_INTEGRITY_MANIFEST) expect(source).toContain(`'${sha256}'`);
  });

  it('rejects a missing entry, an unknown or duplicate entry and a wrong order', () => {
    const m = [...MIGRATION_INTEGRITY_MANIFEST];
    expect(() => assertIntegrityManifestValid(m.filter((e) => e.file !== A_FILE))).toThrow(
      new RegExp(`reviewed migration ${A_FILE} has no approved SHA-256`),
    );
    expect(() => assertIntegrityManifestValid([...m, { file: '20261103090000_new.sql', sha256: 'a'.repeat(64) }])).toThrow(
      /20261103090000_new\.sql is not a reviewed migration/,
    );
    expect(() => assertIntegrityManifestValid([...m, m[0]!])).toThrow(new RegExp(`lists ${BASE_FILE} twice`));
    expect(() => assertIntegrityManifestValid([m[1]!, m[0]!, ...m.slice(2)])).toThrow(/order differs/);
    expect(() => assertIntegrityManifestValid([...m, null as unknown as MigrationIntegrityEntry])).toThrow(/entry 21 is malformed/);
  });

  it('rejects malformed hash values', () => {
    const bad = ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `sha256:${'a'.repeat(57)}`, '', ` ${'a'.repeat(63)}`];
    for (const value of bad) {
      const m = MIGRATION_INTEGRITY_MANIFEST.map((e) => (e.file === B_FILE ? { ...e, sha256: value } : e));
      expect(() => assertIntegrityManifestValid(m), JSON.stringify(value)).toThrow(new RegExp(`hash of ${B_FILE} is not a SHA-256`));
      expect(check(copyMigrations(), m), JSON.stringify(value)).toThrow(/is not a SHA-256/);
    }
  });
});

describe('canonical content', () => {
  it('CRLF and LF give the same hash, equal to SHA-256 of the LF bytes', () => {
    const lf = 'create table t (\n  id int\n);\n-- comment\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const mixed = 'create table t (\r\n  id int\n);\r\n-- comment\n';
    expect(canonicalSha256(Buffer.from(crlf))).toBe(sha(lf));
    expect(canonicalSha256(Buffer.from(mixed))).toBe(sha(lf));
    expect(canonicalSha256(Buffer.from(lf))).toBe(sha(lf));
    expect(canonicalMigrationBytes(Buffer.from('a\r\n\r\nb')).toString()).toBe('a\n\nb');
  });

  it('changes nothing but CRLF: BOM, whitespace, blank lines and non-ASCII text are hashed as they are', () => {
    for (const s of ['\uFEFFselect 1;\n', 'select 1;  \n', 'select\t1;\n', 'select 1;\n\n', 'select 1;', '-- комментарий ✓\n', '']) {
      expect(canonicalMigrationBytes(Buffer.from(s, 'utf8')).toString('utf8'), JSON.stringify(s)).toBe(s);
    }
    expect(canonicalSha256(Buffer.from('\uFEFFselect 1;\n'))).not.toBe(canonicalSha256(Buffer.from('select 1;\n')));
    expect(canonicalSha256(Buffer.from('select 1;\n'))).not.toBe(canonicalSha256(Buffer.from('select 1;')));
  });

  it('rejects invalid UTF-8', () => {
    const cases = [
      Buffer.from([0x73, 0xc3, 0x28, 0x0a]), // invalid continuation byte
      Buffer.from([0x73, 0xff, 0x0a]), // byte never valid in UTF-8
      Buffer.from([0x73, 0xe2, 0x82]), // truncated multi-byte sequence at EOF
      Buffer.from([0xc0, 0xaf]), // overlong encoding
      Buffer.from([0xed, 0xa0, 0x80]), // UTF-16 surrogate
    ];
    for (const bytes of cases) expect(() => canonicalSha256(bytes, 'x.sql'), bytes.toString('hex')).toThrow(/x\.sql is not valid UTF-8/);
  });

  it('rejects a bare CR', () => {
    for (const s of ['a\rb\n', 'a\r', 'a\r\r\nb', '\r', 'a\n\rb']) {
      expect(() => canonicalSha256(Buffer.from(s), 'x.sql'), JSON.stringify(s)).toThrow(/x\.sql has a bare CR/);
    }
  });
});

describe('assertMigrationIntegrity: accepted', () => {
  it('the 21 real migrations of this branch match their approved SHA-256', () => {
    const verified = assertMigrationIntegrity();
    expect(verified).toEqual(MIGRATION_INTEGRITY_MANIFEST.map(({ file, sha256 }) => ({ file, sha256 })));
  });

  it('the same content checked out on Linux (LF) and on Windows (CRLF) passes with identical hashes', () => {
    const linux = assertMigrationIntegrity({ migrationsDir: copyMigrations('lf') });
    const windows = assertMigrationIntegrity({ migrationsDir: copyMigrations('crlf') });
    expect(windows).toEqual(linux);
    expect(linux).toEqual(assertMigrationIntegrity());
  });

  it('the default directory is this repository, independent of process.cwd()', () => {
    expect(DEFAULT_MIGRATIONS_DIR).toBe(join(REPO, 'supabase', 'migrations'));
  });
});

describe('assertMigrationIntegrity: rejected', () => {
  it('one changed SQL character', () => {
    for (const file of [BASE_FILE, A_FILE, B_FILE]) {
      const dir = copyMigrations();
      editText(dir, file, (s) => {
        const i = s.lastIndexOf(';');
        return `${s.slice(0, i)}:${s.slice(i + 1)}`;
      });
      expect(check(dir), file).toThrow(differs(file));
    }
    const dir = copyMigrations();
    editText(dir, A_FILE, (s) => s.replace(/[a-z]/, (c) => c.toUpperCase()));
    expect(check(dir)).toThrow(differs(A_FILE));
  });

  it('an added SQL comment', () => {
    const dir = copyMigrations();
    editText(dir, B_FILE, (s) => `-- harmless looking note\n${s}`);
    expect(check(dir)).toThrow(differs(B_FILE));
    const inline = copyMigrations();
    editText(inline, BASE_FILE, (s) => s.replace(';', '; /* x */'));
    expect(check(inline)).toThrow(differs(BASE_FILE));
  });

  it('changed whitespace inside the content, a BOM, a trailing blank line', () => {
    const edits: ((s: string) => string)[] = [
      (s) => s.replace(' ', '  '),
      (s) => s.replace(' ', '\t'),
      (s) => s.replace('\n', ' \n'),
      (s) => `${s}\n`,
      (s) => s.replace(/\r?\n$/, ''),
      (s) => `\uFEFF${s}`,
    ];
    for (const [i, edit] of edits.entries()) {
      const dir = copyMigrations();
      editText(dir, A_FILE, edit);
      expect(check(dir), `edit ${i}`).toThrow(differs(A_FILE));
    }
  });

  it('a deleted file', () => {
    const dir = copyMigrations();
    unlinkSync(join(dir, A_FILE));
    expect(check(dir)).toThrow(new RegExp(`reviewed migration ${A_FILE} is missing in supabase/migrations`));
  });

  it('an unknown SQL file (also with a valid hash elsewhere) and any other extra entry', () => {
    const dir = copyMigrations();
    writeFileSync(join(dir, '20261103090000_extra.sql'), 'select 1;\n');
    expect(check(dir)).toThrow(/20261103090000_extra\.sql is not a reviewed migration file/);
    const old = copyMigrations();
    writeFileSync(join(old, '20261001090000_backdated.sql'), readFileSync(join(old, BASE_FILE)));
    expect(check(old)).toThrow(/20261001090000_backdated\.sql is not a reviewed migration file/);
    const notes = copyMigrations();
    writeFileSync(join(notes, 'README.md'), 'notes\n');
    expect(check(notes)).toThrow(/README\.md is not a reviewed migration file/);
  });

  it('a renamed file', () => {
    const dir = copyMigrations();
    renameSync(join(dir, B_FILE), join(dir, `${B_FILE.slice(0, 14)}_renamed.sql`));
    expect(check(dir)).toThrow(new RegExp(`has the version of the reviewed ${B_FILE} but a different file name`));
  });

  it('a directory or other non-regular entry under a reviewed name', () => {
    const dir = copyMigrations();
    unlinkSync(join(dir, A_FILE));
    mkdirSync(join(dir, A_FILE));
    expect(check(dir)).toThrow(new RegExp(`${A_FILE} is not a regular file`));
  });

  it('a missing manifest entry and a wrong (but well-formed) SHA-256', () => {
    const dir = copyMigrations();
    expect(check(dir, MIGRATION_INTEGRITY_MANIFEST.filter((e) => e.file !== B_FILE))).toThrow(
      new RegExp(`reviewed migration ${B_FILE} has no approved SHA-256`),
    );
    const other = MIGRATION_INTEGRITY_MANIFEST[0].sha256;
    const swapped = MIGRATION_INTEGRITY_MANIFEST.map((e) => (e.file === A_FILE ? { ...e, sha256: other } : e));
    expect(check(dir, swapped)).toThrow(differs(A_FILE));
    const random = MIGRATION_INTEGRITY_MANIFEST.map((e) => (e.file === B_FILE ? { ...e, sha256: '0'.repeat(64) } : e));
    expect(check(dir, random)).toThrow(differs(B_FILE));
  });

  it('invalid UTF-8 and a bare CR in a real migration copy', () => {
    const utf = copyMigrations();
    editBytes(utf, A_FILE, (b) => Buffer.concat([b, Buffer.from([0x2d, 0x2d, 0x20, 0xc3, 0x28, 0x0a])]));
    expect(check(utf)).toThrow(new RegExp(`${A_FILE} is not valid UTF-8`));
    const cr = copyMigrations('lf');
    editText(cr, B_FILE, (s) => s.replace('\n', '\r'));
    expect(check(cr)).toThrow(new RegExp(`${B_FILE} has a bare CR`));
  });

  it('reports every changed file, not only the first', () => {
    const dir = copyMigrations();
    for (const file of [BASE_FILE, B_FILE]) editText(dir, file, (s) => `${s}-- x\n`);
    expect(check(dir)).toThrow(new RegExp(`in 2 file\\(s\\):\\n  ${BASE_FILE}: [^\\n]+\\n  ${B_FILE}: `));
  });

  it('a file changed after the plan but before the re-check right before db push (no cached result)', () => {
    const dir = copyMigrations();
    expect(check(dir)).not.toThrow(); // plan step
    editText(dir, A_FILE, (s) => s.replace(';', '; drop table if exists shops;'));
    expect(check(dir)).toThrow(differs(A_FILE)); // re-check before db push
    editText(dir, A_FILE, (s) => s.replace('; drop table if exists shops;', ';'));
    expect(check(dir)).not.toThrow(); // re-read from disk again, nothing remembered
  });

  it('an unreadable migrations directory', () => {
    expect(check(join(tmpRoot, 'does-not-exist'))).toThrow(/can not read the migrations directory/);
  });
});

describe('CLI scripts (independent of the working directory)', () => {
  const tsx = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (script: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [tsx, join(REPO, 'scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const elsewhere = mkdtempSync(join(tmpRoot, 'cwd-'));

  it('pnpm check:migration-integrity: passes for the real set, from any working directory', () => {
    for (const cwd of [REPO, elsewhere]) {
      const r = run('check-migration-integrity.ts', [], cwd);
      expect(r.status, r.stderr).toBe(0);
      for (const { file, sha256 } of MIGRATION_INTEGRITY_MANIFEST) expect(r.stdout).toContain(`OK  ${sha256}  ${file}`);
      expect(r.stdout).toContain('all 21 reviewed migration file(s)');
      expect(r.stdout).toContain('(baseline 11, 3A 5, 3B 4, 4A 1)');
    }
  });

  it('hash: prints the canonical SHA-256 (CRLF → LF) and never writes; errors exit non-zero', () => {
    const dir = copyMigrations('crlf');
    const r = run('check-migration-integrity.ts', ['hash', join(dir, A_FILE)], elsewhere);
    expect(r.status, r.stderr).toBe(0);
    const approved = MIGRATION_INTEGRITY_MANIFEST.find((e) => e.file === A_FILE)!.sha256;
    expect(r.stdout.trim()).toBe(`${approved}  ${join(dir, A_FILE)}`);
    const badCr = join(elsewhere, 'bad.sql');
    writeFileSync(badCr, 'a\rb\n');
    expect(run('check-migration-integrity.ts', ['hash', badCr], elsewhere).status).toBe(1);
    expect(run('check-migration-integrity.ts', ['hash'], elsewhere).status).toBe(1);
    expect(run('check-migration-integrity.ts', ['hash', join(elsewhere, 'missing.sql')], elsewhere).status).toBe(1);
    expect(run('check-migration-integrity.ts', ['bogus'], elsewhere).status).toBe(1);
  });

  it('a tampered checkout makes both CLIs exit non-zero before any plan (temporary copy of scripts + migrations)', () => {
    // The scripts resolve supabase/migrations from their own location, so a copied tree checks its own copied files.
    const root = mkdtempSync(join(tmpRoot, 'repo-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    for (const f of ['check-migration-integrity.ts', 'check-production-migration-plan.ts']) {
      writeFileSync(join(root, 'scripts', f), readFileSync(join(REPO, 'scripts', f)));
    }
    for (const f of ['migration-plan.ts', 'migration-integrity.ts', 'migration-integrity-manifest.ts']) {
      writeFileSync(join(root, 'scripts', 'lib', f), readFileSync(join(REPO, 'scripts', 'lib', f)));
    }
    mkdirSync(join(root, 'supabase'));
    renameSync(copyMigrations(), join(root, 'supabase', 'migrations'));
    const runCopy = (script: string, args: string[] = []) => {
      const r = spawnSync(process.execPath, [tsx, join(root, 'scripts', script), ...args], { cwd: REPO, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const list = join(root, 'list.json');
    writeFileSync(list, JSON.stringify({ migrations: REVIEWED_MIGRATION_FILES.map((f) => ({ local: f.slice(0, 14), remote: f.slice(0, 14), time: '' })) }));

    expect(runCopy('check-migration-integrity.ts').status).toBe(0); // intact copy passes
    editText(join(root, 'supabase', 'migrations'), B_FILE, (s) => `${s}-- tampered\n`);
    const integrity = runCopy('check-migration-integrity.ts');
    expect(integrity.status).toBe(1);
    expect(integrity.stderr).toMatch(new RegExp(differs(B_FILE).source.replace(/\$$/, '')));
    expect(integrity.stdout).toBe('');
    const verify = runCopy('check-production-migration-plan.ts', ['verify-applied', list]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toBe('');
    expect(verify.stderr).toContain(`${B_FILE}: approved`);
    const plan = runCopy('check-production-migration-plan.ts', ['plan', list, list, '--expect-stages', '3A,3B,4A']);
    expect(plan.status).toBe(1);
    expect(plan.stderr).toMatch(/content differs[\s\S]*Deployment stopped before any database change/);
  });

  it('check-production-migration-plan.ts runs the integrity check first, from any working directory', () => {
    const list = join(elsewhere, 'list.json');
    const dry = join(elsewhere, 'dry.json');
    writeFileSync(list, JSON.stringify({ migrations: REVIEWED_MIGRATION_FILES.map((f) => ({ local: f.slice(0, 14), remote: f.slice(0, 14), time: '' })) }));
    writeFileSync(dry, JSON.stringify({ upToDate: true, dryRun: true, migrations: [], seeds: [], roles: [] }));
    const out = join(elsewhere, 'out.txt');
    writeFileSync(out, '');
    const plan = run('check-production-migration-plan.ts', ['plan', list, dry], elsewhere, { GITHUB_OUTPUT: out });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toMatch(/^Integrity: 21 reviewed migration file\(s\) match the approved SHA-256\.\nPlan: skip/);
    expect(readFileSync(out, 'utf8')).toBe('mode=skip\nstages=\n');
    const verify = run('check-production-migration-plan.ts', ['verify-applied', list], elsewhere);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toMatch(/^Integrity: 21 reviewed migration file\(s\) match the approved SHA-256\.\nVerified:/);
  });
});

// Expand/Contract: 3B (stock_status projection) is the Expand step; the Contract step (3C: revoke the table SELECT on
// product_variants from anon / authenticated, column grants without stock_quantity) is NOT part of this release.
describe('stock status: Expand only, no Contract (3C) in this release', () => {
  const STOCK_FILE = '20261102090100_stock_status_projection.sql';
  /** SQL without `--` comments, whitespace collapsed, lower case: only executable statements are matched. */
  const sqlOf = (file: string) =>
    readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), 'utf8')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();

  it('the release has exactly the Expand stages 3A, 3B and 4A; no 3C stage and no migration after 4A', () => {
    expect(MIGRATION_STAGES.map((s) => s.id)).toEqual(['3A', '3B', '4A']);
    expect(MIGRATION_STAGES[1].files).toContain(STOCK_FILE);
    expect(readdirSync(DEFAULT_MIGRATIONS_DIR).sort()).toEqual([...REVIEWED_MIGRATION_FILES].sort());
    expect(REVIEWED_MIGRATION_FILES.at(-1)).toBe('20261107090000_telegram_bot_connection.sql');
  });

  it('4A (bot connection) is additive: no drop, no change of an existing table, every new public function service_role only', () => {
    const file = MIGRATION_STAGES[2].files[0];
    const sql = sqlOf(file);
    expect(sql, file).not.toMatch(/\bdrop (table|column|function|schema|policy|view|index)\b/);
    expect(sql, file).not.toMatch(/\balter table (public|private|vault)\./);
    expect(sql, file).not.toMatch(/\b(update|delete from|insert into) public\./);
    expect(sql, file).not.toMatch(/\bgrant [^;]*\b(anon|authenticated)\b/);
    const created = [...sql.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]!);
    expect(created.length).toBeGreaterThan(0);
    for (const fn of created) {
      expect(sql, fn).toMatch(new RegExp(`revoke all on function ${fn.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql, fn).toMatch(new RegExp(`grant execute on function ${fn.replace('.', '\\.')}\\([^)]*\\) to service_role;`));
    }
  });

  it('3B adds stock_status and admin_variant_stock and keeps admin_variant_stock away from anon', () => {
    const sql = sqlOf(STOCK_FILE);
    expect(sql).toContain('alter table public.product_variants add column stock_status text generated always as');
    expect(sql).toContain('create or replace function public.admin_variant_stock(p_shop_id uuid)');
    expect(sql).toContain('not public.is_shop_member(p_shop_id)');
    expect(sql).toContain('revoke all on function public.admin_variant_stock(uuid) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.admin_variant_stock(uuid) to authenticated, service_role;');
    expect(sql).not.toMatch(/grant [^;]*on function public\.admin_variant_stock[^;]*\banon\b/);
  });

  it('no migration revokes SELECT on product_variants or narrows it to column grants (that is the Contract step)', () => {
    for (const file of REVIEWED_MIGRATION_FILES) {
      const sql = sqlOf(file);
      expect(sql, file).not.toMatch(/revoke [^;]*\bselect\b[^;]*on (table )?public\.product_variants\b/);
      expect(sql, file).not.toMatch(/revoke all [^;]*on (table )?public\.product_variants\b/);
      expect(sql, file).not.toMatch(/grant select ?\([^)]*\) on (table )?public\.product_variants\b/);
    }
    // The baseline (20261014090100) revokes everything and then grants SELECT on product_variants again; a release
    // stage must not revoke table privileges wholesale.
    for (const file of MIGRATION_STAGES.flatMap((s) => s.files)) {
      expect(sqlOf(file), file).not.toMatch(/revoke [^;]*on all tables in schema public[^;]*\b(anon|authenticated)\b/);
    }
  });
});
