import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { localStack, publishesDbPort } from '../scripts/lib/local-stack.ts';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';
import { totp } from '../scripts/lib/totp.ts';

// E2E helpers for throw-away accounts and shops on the LOCAL stack (guards: playwright.config.ts, global-setup.ts).

const db = serviceClient();

export interface Account {
  id: string;
  email: string;
  password: string;
  /** Platform admins: secret of their verified TOTP factor (MFA is mandatory for them, 20261102090000). */
  totpSecret?: string;
}

const anonClient = () => {
  const env = resolveSupabaseEnv();
  return createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

/**
 * Throw-away account. `platformAdmin`: also a row in platform_admins and, unless `mfa: false`, a verified TOTP factor
 * enrolled through the real Supabase Auth MFA flow (its secret is kept to produce codes later).
 */
export async function createAccount(label: string, opts: { platformAdmin?: boolean; mfa?: boolean } = {}): Promise<Account> {
  const email = `e2e-${label}-${randomBytes(3).toString('hex')}@e2e.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const account: Account = { id: data.user.id, email, password };
  if (opts.platformAdmin) {
    const { error: pe } = await db.from('platform_admins').insert({ user_id: data.user.id });
    if (pe) throw pe;
    if (opts.mfa !== false) account.totpSecret = await enrollTotp(account);
  }
  return account;
}

/** Enrolls and verifies a TOTP factor for the account (Supabase Auth MFA); returns its secret. */
export async function enrollTotp(a: Pick<Account, 'email' | 'password'>): Promise<string> {
  const client = anonClient();
  const { error: se } = await client.auth.signInWithPassword({ email: a.email, password: a.password });
  if (se) throw se;
  const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `e2e-${randomBytes(3).toString('hex')}` });
  if (error) throw error;
  const { error: ve } = await client.auth.mfa.challengeAndVerify({ factorId: data.id, code: totp(data.totp.secret) });
  if (ve) throw ve;
  return data.totp.secret;
}

const sessions = new Map<string, { token: string; sessionId: string }>();

/** Access token (aal2 for a platform admin with a factor: password + current TOTP code) and its Auth session id. */
export async function signedIn(a: Account): Promise<{ token: string; sessionId: string }> {
  const cached = sessions.get(a.id);
  if (cached) return cached;
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: a.email, password: a.password });
  if (error) throw error;
  if (a.totpSecret) {
    const { data: f, error: fe } = await client.auth.mfa.listFactors();
    if (fe) throw fe;
    const factor = f.totp.find((x) => x.status === 'verified');
    if (!factor) throw new Error(`signedIn: ${a.email} has no verified factor`);
    const { error: ve } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(a.totpSecret) });
    if (ve) throw ve;
  }
  const token = (await client.auth.getSession()).data.session!.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { session_id: string };
  const s = { token, sessionId: claims.session_id };
  sessions.set(a.id, s);
  return s;
}

export async function accessToken(a: Account): Promise<string> {
  return (await signedIn(a)).token;
}

/**
 * Service-role client acting in the platform admin's aal2 session, exactly like the platform-admin Edge Function
 * (x-platform-session). Needed for direct platform RPCs: without it the SQL refuses them (mfa_required).
 */
export async function platformService(a: Account) {
  const env = resolveSupabaseEnv();
  const { sessionId } = await signedIn(a);
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-platform-session': sessionId } },
  });
}

/** Browser: after the password step a platform admin lands on /admin/mfa and enters the current code. */
export async function completeMfa(page: Page, a: Pick<Account, 'totpSecret'>): Promise<void> {
  if (!a.totpSecret) return;
  await expect(page.getByTestId('mfa-page')).toBeVisible();
  await page.getByTestId('mfa-code').fill(totp(a.totpSecret));
  await page.getByTestId('mfa-submit').click();
  await expect(page.getByTestId('mfa-page')).toHaveCount(0);
}

/** Calls the platform-admin Edge Function exactly like the admin UI does. */
export async function platformAdmin(token: string, body: Record<string, unknown>) {
  const env = resolveSupabaseEnv();
  const res = await fetch(`${env.url}/functions/v1/platform-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** A DEMO clone of a template (catalog + media), created through the real server path. */
export async function createDemoShop(admin: Account, templateSlug: string, slug: string, name: string): Promise<{ id: string; slug: string }> {
  const { data: tpl, error } = await db.from('shops').select('id').eq('slug', templateSlug).single();
  if (error) throw error;
  const res = await platformAdmin(await accessToken(admin), { action: 'create-demo', templateId: tpl.id, slug, name });
  if (res.status !== 201) throw new Error(`create-demo failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body!.shop as { id: string; slug: string };
}

export async function deleteShops(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.from('orders').delete().eq('shop_id', id);
    for (const dir of ['logo', 'cover', 'seed', 'products', 'categories']) {
      const { data } = await db.storage.from('shop-media').list(`${id}/${dir}`, { limit: 1000 });
      const paths = (data ?? []).map((f) => `${id}/${dir}/${f.name}`);
      if (paths.length) await db.storage.from('shop-media').remove(paths);
    }
    await db.from('shops').delete().eq('id', id);
  }
}

export async function deleteUsers(ids: string[]): Promise<void> {
  for (const id of ids) await db.auth.admin.deleteUser(id);
}

/** DB container of the stack this checkout belongs to (supabase/config.toml project_id), never another stack. */
const LOCAL_DB_CONTAINER = localStack().dbContainer;

/**
 * SQL as `postgres` in the LOCAL DB container only (private.* is not exposed through PostgREST). Refuses to run unless
 * the resolved Supabase URL is loopback, is this project's API port and the container publishes this project's DB port.
 */
export function localSql(sql: string): string {
  const env = resolveSupabaseEnv();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.url)) throw new Error(`localSql: refusing non-local Supabase ${env.url}`);
  if (new URL(env.url).port !== String(localStack().apiPort)) throw new Error(`localSql: ${env.url} is not this project's stack`);
  const ports = execFileSync('docker', ['port', LOCAL_DB_CONTAINER, '5432/tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!publishesDbPort(ports, localStack().dbPort)) throw new Error(`localSql: ${LOCAL_DB_CONTAINER} does not publish ${localStack().dbPort}`);
  return execFileSync('docker', ['exec', '-i', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-q', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  }).trim();
}

/** Messages of the local Mailpit (supabase/config.toml [local_smtp]). */
export async function latestMailTo(email: string): Promise<{ ID: string } | null> {
  const res = await fetch(`${localStack().mailUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`);
  if (!res.ok) return null;
  const json = (await res.json()) as { messages: Array<{ ID: string }> };
  return json.messages[0] ?? null;
}

export async function mailHtml(id: string): Promise<string> {
  const res = await fetch(`${localStack().mailUrl}/api/v1/message/${id}`);
  const json = (await res.json()) as { HTML: string; Text: string };
  return json.HTML || json.Text;
}
