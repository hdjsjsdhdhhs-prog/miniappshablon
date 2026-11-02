/**
 * Deno type-check of the Supabase Edge Functions (`pnpm check:edge-functions`, CI job `edge-functions-deno-check`).
 *
 * What is checked: the entrypoint `index.ts` of EVERY function directory in supabase/functions plus EVERY non-test
 * module of supabase/functions/_shared (so a shared module is checked even while no function imports it yet). The
 * `_shared/*.test.ts` files are vitest tests (they import `vitest` and modules without the `.ts` extension) and are
 * covered by `pnpm test`; they are not Deno code and are never deployed.
 *
 * How (reproducible, same conditions as the Edge Runtime, nothing written to the repository):
 *   * Deno DENO_VERSION exactly = the Deno inside the Supabase Edge Runtime of the pinned CLI (supabase 2.120.0 →
 *     edge-runtime v1.77.4 → `deno 2.1.4`, read from the local runtime container with `edge-runtime --version`);
 *   * `--no-config` + DENO_NO_PACKAGE_JSON=1: no deno.json and no root package.json (the functions use explicit
 *     `npm:<pkg>@<exact version>` and relative `.ts` imports only, exactly as they are deployed);
 *   * `--lock=EDGE_FUNCTIONS_LOCK --frozen`: the npm packages AND their transitive dependencies are pinned by version
 *     and integrity hash; a missing or different entry fails the check instead of silently updating the lock.
 * The lock lives outside supabase/functions on purpose: a deno.json / deno.lock / import map there would change how
 * `supabase functions deploy` bundles the functions. It pins the CHECK only; the deploy resolves the same exact
 * `npm:` versions itself.
 *
 * Updating a dependency (by hand, reviewed): change the `npm:` version in the source, then regenerate the lock with
 * Deno DENO_VERSION: `DENO_NO_PACKAGE_JSON=1 deno check --no-config --lock=scripts/deno/edge-functions.lock <files>`
 * (without --frozen), review the diff and run `pnpm check:edge-functions`.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FUNCTIONS_DIR = join(REPO_ROOT, 'supabase', 'functions');

/** = `deno --version` of public.ecr.aws/supabase/edge-runtime:v1.77.4 (Supabase CLI 2.120.0). */
export const DENO_VERSION = '2.1.4';
/** Repository-relative path, passed to Deno with cwd = REPO_ROOT. */
export const EDGE_FUNCTIONS_LOCK = 'scripts/deno/edge-functions.lock';
/** Environment for every Deno call: ignore the root package.json (Node tooling, not Edge Function dependencies). */
export const DENO_ENV: Readonly<Record<string, string>> = { DENO_NO_PACKAGE_JSON: '1' };

export interface EdgeFunctionModules {
  /** Function names (directory names), sorted. */
  functions: string[];
  /** `supabase/functions/<name>/index.ts`, same order as `functions`. */
  entrypoints: string[];
  /** `supabase/functions/_shared/<module>.ts` without the vitest `*.test.ts` files, sorted. */
  shared: string[];
}

function fail(reason: string): never {
  throw new Error(`Edge Functions check: ${reason}`);
}

const FUNCTION_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Lists what must be type-checked. Anything unexpected (a function without index.ts, an unknown `_` directory, a file
 * such as deno.json / import_map.json directly in supabase/functions, a sub-directory of _shared) stops the check, so
 * nothing new can silently stay unchecked. Dotfiles (e.g. a local, gitignored `.env`) are ignored.
 */
export function listEdgeFunctionModules(dir: string = FUNCTIONS_DIR): EdgeFunctionModules {
  const functions: string[] = [];
  const shared: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) fail(`unexpected file supabase/functions/${entry.name} (deno.json / import maps change how the CLI bundles functions; review it first)`);
    if (entry.name === '_shared') {
      for (const mod of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (mod.name.startsWith('.')) continue;
        if (!mod.isFile()) fail(`unexpected directory supabase/functions/_shared/${mod.name}`);
        if (!mod.name.endsWith('.ts')) fail(`unexpected file supabase/functions/_shared/${mod.name}`);
        if (!mod.name.endsWith('.test.ts')) shared.push(`supabase/functions/_shared/${mod.name}`);
      }
      continue;
    }
    if (entry.name.startsWith('_')) fail(`unknown shared directory supabase/functions/${entry.name}`);
    if (!FUNCTION_NAME.test(entry.name)) fail(`unexpected function directory name "${entry.name}"`);
    const files = readdirSync(join(dir, entry.name));
    if (!files.includes('index.ts')) fail(`function ${entry.name} has no index.ts`);
    functions.push(entry.name);
  }
  if (functions.length === 0) fail('no Edge Function found in supabase/functions');
  shared.sort();
  return { functions, entrypoints: functions.map((f) => `supabase/functions/${f}/index.ts`), shared };
}

/** Arguments of the one `deno check` call (cwd = REPO_ROOT). */
export function denoCheckArgs(files: readonly string[]): string[] {
  if (files.length === 0) fail('nothing to check');
  return ['check', '--no-config', `--lock=${EDGE_FUNCTIONS_LOCK}`, '--frozen', ...files];
}

/** `deno --version` → "2.1.4"; null for anything else. */
export function parseDenoVersion(output: string): string | null {
  return /^deno (\d+\.\d+\.\d+)\b/m.exec(output)?.[1] ?? null;
}

/** Function names configured in supabase/config.toml (`[functions.<name>]`). */
export function configuredFunctions(configToml: string): string[] {
  return [...configToml.matchAll(/^\[functions\.([a-z0-9-]+)\]\s*$/gm)].map((m) => m[1]!).sort();
}

/** Function names deployed by .github/workflows/supabase-deploy.yml (`supabase functions deploy <name>`). */
export function deployedFunctions(workflowYaml: string): string[] {
  return [...workflowYaml.matchAll(/supabase functions deploy ([a-z0-9-]+)/g)].map((m) => m[1]!).sort();
}

/** Every module specifier imported by a source file (static `import … from`, `export … from`, dynamic `import()`). */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}
