// Usage:
//   tsx scripts/check-edge-functions.ts
//     → type-checks every Supabase Edge Function entrypoint and every non-test module of supabase/functions/_shared
//       with Deno DENO_VERSION (scripts/lib/edge-functions.ts): `deno check --no-config --lock=… --frozen`, with
//       DENO_NO_PACKAGE_JSON=1. Exits non-zero on a missing / different Deno, an unexpected file layout, a lock that
//       does not match, or any type or module-resolution error. Writes nothing.
//   Deno binary: $DENO_BIN, otherwise `deno` on PATH (CI: denoland/setup-deno with the same version).
import { spawnSync } from 'node:child_process';
import { DENO_ENV, DENO_VERSION, denoCheckArgs, EDGE_FUNCTIONS_LOCK, listEdgeFunctionModules, parseDenoVersion, REPO_ROOT } from './lib/edge-functions.ts';

const deno = process.env.DENO_BIN || 'deno';

try {
  if (process.argv.length > 2) throw new Error('Usage: check-edge-functions.ts (no arguments)');

  const version = spawnSync(deno, ['--version'], { encoding: 'utf8', env: { ...process.env, ...DENO_ENV } });
  if (version.error || version.status !== 0) {
    throw new Error(`Edge Functions check: Deno is not available as "${deno}" (install Deno ${DENO_VERSION} or set DENO_BIN)`);
  }
  const found = parseDenoVersion(version.stdout);
  if (found !== DENO_VERSION) {
    throw new Error(`Edge Functions check: Deno ${DENO_VERSION} is required (= Supabase Edge Runtime), found ${found ?? 'an unrecognised version'}`);
  }

  const modules = listEdgeFunctionModules();
  const files = [...modules.entrypoints, ...modules.shared];
  console.log(
    `Deno ${found}: checking ${modules.functions.length} Edge Function(s) (${modules.functions.join(', ')}) and ` +
      `${modules.shared.length} _shared module(s), lock ${EDGE_FUNCTIONS_LOCK} (frozen).`,
  );
  const check = spawnSync(deno, denoCheckArgs(files), { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...DENO_ENV } });
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error(`Edge Functions check: deno check failed (exit ${check.status ?? 'signal'})`);
  console.log(`Edge Functions check: all ${files.length} module(s) type-check with Deno ${found}.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
