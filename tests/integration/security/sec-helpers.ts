// Helpers for the stage-2 security PoC suites. LOCAL ONLY.
// The base helpers (../helpers.ts) already refuse a non-loopback Supabase URL before any client is created.
// psqlAsync() additionally talks only to the local Docker container of THIS project's stack and checks that the
// container publishes the local DB port, so it can never reach a hosted database.
import { execFileSync, spawn } from 'node:child_process';
import { localStack, publishesDbPort } from '../../../scripts/lib/local-stack.ts';
import { admin, cleanup, env, serviceAs } from '../helpers';

/** Start of this test file's run: cleanupSecurity() only touches objects created after it. */
const RUN_STARTED_AT = new Date(Date.now() - 1000).toISOString();

/** DB container of the stack this checkout belongs to (supabase/config.toml project_id), never another stack. */
export const LOCAL_DB_CONTAINER = localStack().dbContainer;

let checked = false;
function assertLocalDbContainer(): void {
  if (checked) return;
  if (!env.isLocal || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.url)) {
    throw new Error(`security PoC: refusing non-local Supabase ${env.url}`);
  }
  if (new URL(env.url).port !== String(localStack().apiPort)) {
    throw new Error(`security PoC: ${env.url} is not the API of this project's stack (port ${localStack().apiPort})`);
  }
  const ports = execFileSync('docker', ['port', LOCAL_DB_CONTAINER, '5432/tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!publishesDbPort(ports, localStack().dbPort)) {
    throw new Error(`security PoC: ${LOCAL_DB_CONTAINER} does not publish the local DB port ${localStack().dbPort} (${ports.trim()})`);
  }
  checked = true;
}

/**
 * Runs SQL as `postgres` inside the LOCAL DB container, asynchronously (unlike helpers.localSql, it does not block
 * the event loop, so it can hold locks / sleep while HTTP requests run in parallel). Returns stdout (-tA format).
 */
export function psqlAsync(sql: string): Promise<{ code: number; out: string; err: string }> {
  assertLocalDbContainer();
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-q', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }));
    p.stdin.end(sql);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Service-role RPC without the generated argument types: `supabase gen types` declares every SQL argument as
 * non-null, but several RPCs take NULL on purpose (notify_claim(p_order_id | p_shop_id), p_expected_total_minor …).
 */
export function svcRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
  const db = platformSession ? serviceAs(platformSession) : admin;
  return db.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;
}

let platformSession: string | null = null;
/**
 * Makes svcRpc forward this aal2 session (x-platform-session) like the Edge Functions do (20261102090000). The SQL
 * accepts it only when it is a live aal2 session of the call's p_actor, so calls for other actors still get
 * forbidden / mfa_required exactly as before.
 */
export function svcRpcActsIn(sessionId: string | null): void {
  platformSession = sessionId;
}

/**
 * helpers.cleanup() + removal of the media this run left behind. helpers.cleanup() lists only two levels
 * ("<shop>/<dir>/"), while media live at "<shop>/<entity>/<id>/<file>", so deeper objects of deleted test shops
 * would stay in the bucket. Removes (through the Storage API, service role) ONLY objects of shop-media that were
 * created after this file started AND whose shop row no longer exists.
 */
export async function cleanupSecurity(): Promise<void> {
  await cleanup();
  const r = await psqlAsync(
    `select o.name from storage.objects o
     where o.bucket_id = 'shop-media' and o.created_at >= '${RUN_STARTED_AT}'
       and not exists (select 1 from public.shops s where s.id::text = split_part(o.name, '/', 1));`,
  );
  if (r.code !== 0) throw new Error(`media cleanup query failed: ${r.err}`);
  const names = r.out.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < names.length; i += 100) {
    const { error } = await admin.storage.from('shop-media').remove(names.slice(i, i + 100));
    if (error) throw error;
  }
}

/** 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
