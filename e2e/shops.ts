import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';

// E2E helpers for throw-away accounts and shops on the LOCAL stack (guards: playwright.config.ts, global-setup.ts).

const db = serviceClient();

export interface Account {
  id: string;
  email: string;
  password: string;
}

export async function createAccount(label: string, opts: { platformAdmin?: boolean } = {}): Promise<Account> {
  const email = `e2e-${label}-${randomBytes(3).toString('hex')}@e2e.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  if (opts.platformAdmin) {
    const { error: pe } = await db.from('platform_admins').insert({ user_id: data.user.id });
    if (pe) throw pe;
  }
  return { id: data.user.id, email, password };
}

export async function accessToken(a: Account): Promise<string> {
  const env = resolveSupabaseEnv();
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: a.email, password: a.password });
  if (error) throw error;
  return data.session.access_token;
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

/** Messages of the local Mailpit (supabase/config.toml [local_smtp]). */
export async function latestMailTo(email: string): Promise<{ ID: string } | null> {
  const res = await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`);
  if (!res.ok) return null;
  const json = (await res.json()) as { messages: Array<{ ID: string }> };
  return json.messages[0] ?? null;
}

export async function mailHtml(id: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:54324/api/v1/message/${id}`);
  const json = (await res.json()) as { HTML: string; Text: string };
  return json.HTML || json.Text;
}
