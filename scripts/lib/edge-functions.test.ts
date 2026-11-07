import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configuredFunctions,
  DENO_ENV,
  DENO_VERSION,
  denoCheckArgs,
  deployedFunctions,
  EDGE_FUNCTIONS_LOCK,
  FUNCTIONS_DIR,
  importSpecifiers,
  listEdgeFunctionModules,
  parseDenoVersion,
  REPO_ROOT,
} from './edge-functions';

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

describe('Edge Functions covered by deno check', () => {
  const modules = listEdgeFunctionModules();

  it('checks every function that is configured and deployed — not just one', () => {
    expect(modules.functions).toEqual(['bot-connection', 'checkout', 'my-orders', 'notification-settings', 'platform-admin', 'telegram-webhook']);
    expect(modules.functions).toEqual(configuredFunctions(read('supabase/config.toml')));
    expect(modules.functions).toEqual(deployedFunctions(read('.github/workflows/supabase-deploy.yml')));
    expect(modules.entrypoints).toEqual(modules.functions.map((f) => `supabase/functions/${f}/index.ts`));
  });

  it('checks every non-test _shared module, and no vitest file', () => {
    const all = readdirSync(join(FUNCTIONS_DIR, '_shared')).filter((f) => f.endsWith('.ts'));
    const expected = all.filter((f) => !f.endsWith('.test.ts')).map((f) => `supabase/functions/_shared/${f}`).sort();
    expect(modules.shared).toEqual(expected);
    expect(modules.shared.length).toBeGreaterThanOrEqual(9);
    expect(modules.shared.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('runs deno check without config / package.json and with the frozen lock', () => {
    const args = denoCheckArgs(['a.ts', 'b.ts']);
    expect(args).toEqual(['check', '--no-config', `--lock=${EDGE_FUNCTIONS_LOCK}`, '--frozen', 'a.ts', 'b.ts']);
    expect(DENO_ENV).toEqual({ DENO_NO_PACKAGE_JSON: '1' });
    expect(() => denoCheckArgs([])).toThrow(/nothing to check/);
    // The lock must stay outside supabase/functions (a deno.lock there changes how the CLI bundles functions).
    expect(EDGE_FUNCTIONS_LOCK.startsWith('supabase/')).toBe(false);
  });

  it('imports only exact npm: versions and relative .ts files, and the lock pins exactly those npm packages', () => {
    const files = [...modules.entrypoints, ...modules.shared];
    const npm = new Set<string>();
    for (const file of files) {
      for (const spec of importSpecifiers(read(file))) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          expect(spec, `${file}: ${spec}`).toMatch(/\.ts$/);
        } else {
          expect(spec, `${file}: unpinned or remote import ${spec}`).toMatch(/^npm:(@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+$/);
          npm.add(spec);
        }
      }
    }
    expect([...npm].sort()).toEqual(['npm:@supabase/supabase-js@2.117.3', 'npm:zod@4.6.7']);

    const lock = JSON.parse(read(EDGE_FUNCTIONS_LOCK)) as { version: string; specifiers: Record<string, string>; npm: Record<string, { integrity: string }> };
    expect(lock.version).toBe('4');
    expect(Object.keys(lock.specifiers).sort()).toEqual([...npm].sort());
    for (const [spec, resolved] of Object.entries(lock.specifiers)) expect(spec.endsWith(`@${resolved}`)).toBe(true);
    // Transitive dependencies are pinned too, each with an integrity hash.
    expect(Object.keys(lock.npm).length).toBeGreaterThan(npm.size);
    for (const [pkg, entry] of Object.entries(lock.npm)) expect(entry.integrity, pkg).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
  });

  it('pins the Deno of the Edge Runtime in CI', () => {
    expect(DENO_VERSION).toBe('2.1.4');
    expect(read('.github/workflows/ci.yml')).toMatch(new RegExp(`deno-version: ${DENO_VERSION.replace(/\./g, '\\.')}\\s`));
  });

  it('parses deno --version', () => {
    expect(parseDenoVersion('deno 2.1.4 (stable, release, x86_64-unknown-linux-gnu)\nv8 13.0\ntypescript 5.6.2\n')).toBe('2.1.4');
    expect(parseDenoVersion('v22.11.0\n')).toBeNull();
    expect(parseDenoVersion('')).toBeNull();
  });

  it('extracts static, type-only, re-export and dynamic import specifiers', () => {
    const src = [
      "import { z } from 'npm:zod@4.6.7';",
      "import type { X } from './a.ts';",
      "export { y } from '../b.ts';",
      "const m = await import('./c.ts');",
      "import './side-effect.ts';",
      "const s = 'from nowhere';",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(['npm:zod@4.6.7', './a.ts', '../b.ts', './c.ts', './side-effect.ts']);
  });
});

describe('listEdgeFunctionModules refuses layouts that would leave code unchecked', () => {
  const base = mkdtempSync(join(tmpdir(), 'edge-functions-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  let n = 0;
  const layout = (files: Record<string, string>) => {
    const dir = join(base, String(n++));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };

  it('accepts functions + _shared and ignores dotfiles and vitest files', () => {
    const dir = layout({ 'b-fn/index.ts': '', 'a-fn/index.ts': '', '_shared/x.ts': '', '_shared/x.test.ts': '', '.env': 'X=1' });
    expect(listEdgeFunctionModules(dir)).toEqual({
      functions: ['a-fn', 'b-fn'],
      entrypoints: ['supabase/functions/a-fn/index.ts', 'supabase/functions/b-fn/index.ts'],
      shared: ['supabase/functions/_shared/x.ts'],
    });
  });

  it('refuses a function without index.ts, unknown files and directories', () => {
    expect(() => listEdgeFunctionModules(layout({ 'fn/main.ts': '' }))).toThrow(/fn has no index.ts/);
    expect(() => listEdgeFunctionModules(layout({ 'fn/index.ts': '', 'deno.json': '{}' }))).toThrow(/unexpected file supabase\/functions\/deno.json/);
    expect(() => listEdgeFunctionModules(layout({ 'fn/index.ts': '', '_utils/x.ts': '' }))).toThrow(/unknown shared directory/);
    expect(() => listEdgeFunctionModules(layout({ 'fn/index.ts': '', '_shared/sub/x.ts': '' }))).toThrow(/unexpected directory/);
    expect(() => listEdgeFunctionModules(layout({ 'fn/index.ts': '', '_shared/data.json': '{}' }))).toThrow(/unexpected file/);
    expect(() => listEdgeFunctionModules(layout({ 'Bad_Name/index.ts': '' }))).toThrow(/unexpected function directory name/);
    expect(() => listEdgeFunctionModules(layout({ '_shared/x.ts': '' }))).toThrow(/no Edge Function/);
  });
});

describe('check-edge-functions.ts refuses to run without the pinned Deno', () => {
  const run = (denoBin: string) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/check-edge-functions.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DENO_BIN: denoBin },
    });

  it('fails when Deno is missing', () => {
    const r = run(join(tmpdir(), 'no-such-deno-binary'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Deno is not available/);
  });

  it('fails on another version before checking anything', () => {
    // `node --version` prints "v22…": not a Deno version, so no check is started.
    const r = run(process.execPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Deno 2\.1\.4 is required/);
    expect(r.stdout).not.toMatch(/checking/);
  });
});
