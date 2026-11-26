// Deletion of ANY shop, LIVE included (20261113090000, platform-admin actions shop-delete-preview / -challenge /
// shop-delete), and what the same migration changed for DEMO shops. LOCAL ONLY; Telegram is the local mock Bot API.
// The DEMO contract itself (slug only, complete removal, resumable 'deleting' state, reserved slug) is covered by
// demo-deletion.test.ts and is not repeated here.
// Covers: who may delete (only an aal2 platform admin, on every path), the step-up — a TOTP code verified AFTER the
// deletion was opened, in the same Auth session, for the same shop, by the same admin, within 5 minutes — the exact
// slug, complete removal of a LIVE shop with everything stage 4B added (own bot and its Vault secret, welcome,
// audience, broadcasts, buyer notifications), the bot being detached in Telegram, untouched neighbours and accounts,
// the audit row, an interrupted deletion, and DEMO shops with a connected bot (not deletable since 20261107090000).
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockBotState, mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import { DARK_PREMIUM_THEME } from '../../../src/domain/theme.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  fakeBotToken,
  initDataFor,
  track,
  verifyTotp,
  waitFor,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { botFn, botIdOf, privateMessage, shopWithBot, sql, starter } from './bot-helpers';
import { cleanupSecurity, PNG, psqlAsync, sleep } from './sec-helpers';

const run = randomBytes(3).toString('hex');
const bucket = () => admin.storage.from('shop-media');
const errCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;
const pf = (as: Db | null, body: Record<string, unknown>) => callAdminFunction('platform-admin', as, body);
const del = (as: Db | null, shopId: string, confirmSlug: string) => pf(as, { action: 'shop-delete', shopId, confirmSlug });
/** The step-up tolerates a 2 s clock difference between Auth and the database; "before" must be further apart. */
const OUTSIDE_TOLERANCE_MS = 2500;

let pa: PlatformAdmin;
let pb: PlatformAdmin;
let paAal1: PlatformAdmin;

beforeAll(async () => {
  pa = await createPlatformAdmin();
  pb = await createPlatformAdmin();
  paAal1 = await createPlatformAdmin({ mfa: false });
});
afterAll(async () => {
  // Look-alike objects outside any shop prefix are not covered by cleanupSecurity (their "shop" never existed as a row).
  const r = await psqlAsync(`select name from storage.objects where bucket_id = 'shop-media' and name like '%-lookalike-${run}/%';`);
  const names = r.out.split(/\r?\n/).filter(Boolean);
  if (names.length) await bucket().remove(names);
  await cleanupSecurity();
});

/** "Удалить магазин" was opened for this shop (challenge) and the admin typed the current code (same session). */
async function stepUp(a: PlatformAdmin, shopId: string): Promise<void> {
  const challenged = await pf(a.client, { action: 'shop-delete-challenge', shopId });
  expect(challenged.status, challenged.text).toBe(200);
  expect(challenged.body!.challenge).toEqual({ challenged: true, expires_in_sec: 300 });
  await verifyTotp(a.client, a.factorId!, a.totpSecret!);
}

async function upload(path: string): Promise<void> {
  const { error } = await bucket().upload(path, PNG, { contentType: 'image/png', upsert: true });
  if (error) throw error;
}
async function objectsUnder(prefix: string): Promise<string[]> {
  const out = await sql(`select name from storage.objects where bucket_id = 'shop-media' and starts_with(name, '${prefix}') order by name;`);
  return out.split(/\r?\n/).filter(Boolean);
}
async function shopRow(id: string) {
  const { data } = await admin.from('shops').select('id, slug, status, is_demo, mode').eq('id', id).maybeSingle();
  return data;
}
const leftovers = async (id: string) => JSON.parse(await sql(`select private.shop_leftover_rows('${id}');`)) as Record<string, number>;
const vaultSecrets = (id: string, kind: 'shop_tg_notify' | 'shop_tg_bot') => sql(`select count(*) from vault.secrets where name like '${kind}:${id}:%';`);
interface Audit {
  slug: string;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
  last_error: string | null;
  was_demo: boolean | null;
  step_up_at: string | null;
}
const audit = async (id: string) =>
  JSON.parse((await sql(`select coalesce((select row_to_json(d) from private.shop_deletions d where d.shop_id = '${id}'), 'null'::json);`)) || 'null') as Audit | null;

async function liveShop() {
  const shop = await createTestShop();
  const owner = await createOwner(shop.id);
  return { shop, owner };
}

interface Fixture {
  shop: TestShop;
  owner: Awaited<ReturnType<typeof createOwner>>;
  manager: Awaited<ReturnType<typeof createMember>>;
  other: TestShop;
  token: string;
  /** Telegram's side of the bot's webhook, read while the bot was still connected. */
  hook: { connectionId: string; secret: string };
  buyer: number;
  media: string[];
  otherMedia: string;
  lookalike: string;
}

/**
 * A shop in real use: catalog with 2 variants, an image row, media at several depths + logo, an owner who ALSO owns
 * another shop, a manager, the admin notification channel (Vault secret), its own bot (Vault secret) with a custom
 * welcome, two users who started the bot, a completed broadcast, an order with the buyer's confirmation. Plus a
 * neighbour shop with its own file and a look-alike object "<id>-lookalike/…". `demo`: the shop is then marked DEMO.
 */
async function populated(opts: { demo?: boolean } = {}): Promise<Fixture> {
  const S = await shopWithBot({ shop: { variants: [{ flavor: 'Mint', stock: 9 }, { flavor: 'Cherry', stock: 2 }] } });
  const { shop, owner, token } = S;
  const other = await createTestShop();
  const manager = await createMember(shop.id, 'manager');
  const { error: me } = await admin.from('shop_memberships').insert({ shop_id: other.id, user_id: owner.userId, role: 'owner' });
  if (me) throw me;

  const saved = await callAdminFunction('notification-settings', owner.client, {
    action: 'save', shopId: shop.id, botToken: fakeBotToken(), chatId: `@sd_${run}_${randomBytes(2).toString('hex')}`,
  });
  expect(saved.status, saved.text).toBe(200);
  const welcome = await botFn(owner.client, {
    action: 'save-welcome',
    shopId: shop.id,
    welcome: { welcomeText: 'Привет', openButtonText: 'Открыть', managerButtonText: 'Менеджер', managerUrl: '@sd_manager', openButtonEmojiId: '5368324170671202287' },
  });
  expect(welcome.status, welcome.text).toBe(200);
  const state = (await mockBotState(botIdOf(token))).webhook!;
  const hook = { connectionId: new URL(state.url).searchParams.get('c')!, secret: state.secret_token! };

  const buyer = await starter(token);
  await starter(token);
  const order = await callFunction('checkout', await initDataFor(buyer), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]));
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const orderId = (order.body!.order as { id: string }).id;
  // Both order notifications are settled, so nothing is still being sent when the deletion starts.
  const confirmation = await waitFor(() => sql(`select status from private.customer_order_notifications where order_id = '${orderId}';`), (s) => s === 'sent');
  expect(confirmation).toBe('sent');
  await waitFor(() => sql(`select status from private.order_notifications where order_id = '${orderId}';`), (s) => s === 'sent');

  const started = await botFn(owner.client, { action: 'broadcast-start', shopId: shop.id, broadcast: { idempotencyKey: randomUUID(), text: 'Новинки недели' } });
  expect(started.status, started.text).toBe(200);
  for (let i = 0; i < 6; i++) {
    const step = await botFn(owner.client, { action: 'broadcast-run', shopId: shop.id });
    if (!(step.body!.overview as { active: unknown }).active) break;
  }
  expect(await sql(`select status || ':' || total from private.shop_broadcasts where shop_id = '${shop.id}';`)).toBe('completed:2');

  const media = [`${shop.id}/logo/${run}.png`, `${shop.id}/product/${shop.productId}/a.png`, `${shop.id}/product/${shop.productId}/deep/b.png`];
  for (const p of media) await upload(p);
  const { error: ie } = await admin.from('product_images').insert({ shop_id: shop.id, product_id: shop.productId, storage_path: media[1]! });
  if (ie) throw ie;
  const { error: le } = await admin.from('shops').update({ logo_path: media[0]!, ...(opts.demo ? { is_demo: true } : {}) }).eq('id', shop.id);
  if (le) throw le;
  const otherMedia = `${other.id}/product/${other.productId}/keep.png`;
  await upload(otherMedia);
  const lookalike = `${shop.id}-lookalike-${run}/keep.png`;
  await upload(lookalike);
  return { shop, owner, manager, other, token, hook, buyer, media, otherMedia, lookalike };
}

/** Everything of the shop is gone: rows in every table, both Vault secrets, every object under its prefix. */
async function expectGone(F: Fixture): Promise<void> {
  expect(await shopRow(F.shop.id)).toBeNull();
  expect(await leftovers(F.shop.id)).toEqual({});
  expect(await vaultSecrets(F.shop.id, 'shop_tg_notify')).toBe('0');
  expect(await vaultSecrets(F.shop.id, 'shop_tg_bot')).toBe('0');
  expect(await objectsUnder(`${F.shop.id}/`)).toEqual([]);
  for (const table of ['shop_bot_connections', 'shop_bot_assignments', 'shop_bot_welcome', 'bot_subscribers', 'shop_broadcasts', 'broadcast_recipients', 'customer_order_notifications', 'order_notifications', 'shop_delete_challenges']) {
    expect(await sql(`select count(*) from private.${table} where shop_id = '${F.shop.id}';`), table).toBe('0');
  }
  expect(await sql(`select count(*) from vault.decrypted_secrets where decrypted_secret = '${F.token}';`)).toBe('0');
  // Detached in Telegram: our webhook and our Menu Button are removed from the bot.
  expect(await mockBotState(botIdOf(F.token))).toEqual({ webhook: null, menu_button: { type: 'default' } });
}

describe('who may delete a LIVE shop', () => {
  let L: Awaited<ReturnType<typeof liveShop>>;
  let manager: Awaited<ReturnType<typeof createMember>>;
  beforeAll(async () => {
    L = await liveShop();
    manager = await createMember(L.shop.id, 'manager');
  });

  it('nobody but an aal2 platform admin: anonymous, the shop’s own owner / manager, another shop’s owner, aal1 admin — all refused', async () => {
    const stranger = await liveShop();
    const bodies = [
      { action: 'shop-delete-preview', shopId: L.shop.id },
      { action: 'shop-delete-challenge', shopId: L.shop.id },
      { action: 'shop-delete', shopId: L.shop.id, confirmSlug: L.shop.slug },
    ];
    for (const body of bodies) {
      expect((await pf(null, body)).status, body.action).toBe(401);
      for (const [who, client, code] of [
        ['owner', L.owner.client, 'forbidden'],
        ['manager', manager.client, 'forbidden'],
        ['owner of another shop', stranger.owner.client, 'forbidden'],
        ['aal1 platform admin', paAal1.client, 'mfa_required'],
      ] as const) {
        const res = await pf(client, body);
        expect([who, body.action, res.status, errCode(res)]).toEqual([who, body.action, 403, code]);
      }
    }
    expect(await shopRow(L.shop.id)).toMatchObject({ status: 'active', is_demo: false, mode: 'live' });
    expect(await sql(`select count(*) from private.shop_delete_challenges where shop_id = '${L.shop.id}';`)).toBe('0');
    expect(await audit(L.shop.id)).toBeNull();
  });

  it('the RPCs cannot be reached directly: PostgREST for users, the service role without / with a wrong session', async () => {
    const begin = { p_actor: pa.userId, p_shop_id: L.shop.id, p_confirm_slug: L.shop.slug };
    const plain = { p_actor: pa.userId, p_shop_id: L.shop.id };
    for (const c of [anon(), L.owner.client, pa.client]) {
      for (const [fn, args] of [['platform_shop_delete_begin', begin], ['platform_shop_delete_challenge', plain], ['platform_shop_delete_preview', plain]] as const) {
        const r = await c.rpc(fn as never, args as never);
        expect(r.error?.message, fn).toMatch(/permission denied/i);
      }
    }
    for (const fn of ['platform_shop_delete_begin', 'platform_shop_delete_challenge', 'platform_shop_delete_preview'] as const) {
      const args = fn === 'platform_shop_delete_begin' ? begin : plain;
      // Service role, actor = the aal2 admin, but no forwarded session (a compromised caller cannot skip MFA).
      expect((await admin.rpc(fn, args as never)).error?.message, fn).toBe('mfa_required');
      // The aal2 session of one admin does not authorize another account; an aal1 session authorizes nobody.
      expect((await pa.svc.rpc(fn, { ...args, p_actor: L.owner.userId } as never)).error?.message, fn).toBe('forbidden');
      expect((await pa.svc.rpc(fn, { ...args, p_actor: pb.userId } as never)).error?.message, fn).toBe('mfa_required');
      expect((await paAal1.svc.rpc(fn, { ...args, p_actor: paAal1.userId } as never)).error?.message, fn).toBe('mfa_required');
    }
    expect(await shopRow(L.shop.id)).toMatchObject({ status: 'active' });
    expect(await sql(`select count(*) from private.shop_delete_challenges where shop_id = '${L.shop.id}';`)).toBe('0');
  });
});

describe('step-up: a fresh TOTP code for this very deletion', () => {
  it('being signed in with MFA is not enough: without a challenge, or without a code typed after it, nothing is deleted', async () => {
    const { shop } = await liveShop();
    const fresh = await createPlatformAdmin(); // aal2: its TOTP code was verified a moment ago, at sign-in
    // No "Удалить магазин" was opened at all.
    const direct = await del(fresh.client, shop.id, shop.slug);
    expect([direct.status, errCode(direct)]).toEqual([403, 'mfa_step_up_required']);
    expect((await fresh.svc.rpc('platform_shop_delete_begin', { p_actor: fresh.userId, p_shop_id: shop.id, p_confirm_slug: shop.slug })).error?.message).toBe('mfa_step_up_required');
    // Opened, but the only verified code is the one from sign-in — typed BEFORE the deletion was opened.
    await sleep(OUTSIDE_TOLERANCE_MS);
    expect((await pf(fresh.client, { action: 'shop-delete-challenge', shopId: shop.id })).status).toBe(200);
    const stale = await del(fresh.client, shop.id, shop.slug);
    expect([stale.status, errCode(stale)]).toEqual([403, 'mfa_step_up_required']);
    expect(await shopRow(shop.id)).toMatchObject({ status: 'active' });
    expect(await audit(shop.id)).toBeNull();

    // The same admin, the same challenge, now with the current code: accepted.
    await verifyTotp(fresh.client, fresh.factorId!, fresh.totpSecret!);
    const ok = await del(fresh.client, shop.id, shop.slug);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body!.deletion).toMatchObject({ status: 'deleted' });
    expect(await shopRow(shop.id)).toBeNull();
  });

  it('the code counts only for the shop it was typed for, for the admin who typed it, in the session that opened the deletion', async () => {
    const X = (await liveShop()).shop;
    const Y = (await liveShop()).shop;
    await stepUp(pa, X.id);

    // Another shop.
    const otherShop = await del(pa.client, Y.id, Y.slug);
    expect([otherShop.status, errCode(otherShop)]).toEqual([403, 'mfa_step_up_required']);
    // Another platform admin (aal2, its own fresh code, but it never opened this deletion).
    await verifyTotp(pb.client, pb.factorId!, pb.totpSecret!);
    const otherAdmin = await del(pb.client, X.id, X.slug);
    expect([otherAdmin.status, errCode(otherAdmin)]).toEqual([403, 'mfa_step_up_required']);
    // The same admin in another session: a code verified there, after the challenge, does not confirm it.
    const second = anon();
    expect((await second.auth.signInWithPassword({ email: pa.email, password: pa.password })).error).toBeNull();
    await verifyTotp(second, pa.factorId!, pa.totpSecret!);
    const otherSession = await del(second, X.id, X.slug);
    expect([otherSession.status, errCode(otherSession)]).toEqual([403, 'mfa_step_up_required']);
    for (const s of [X, Y]) expect(await shopRow(s.id)).toMatchObject({ status: 'active' });

    // The session that opened the deletion and typed the code deletes X — and only X.
    const ok = await del(pa.client, X.id, X.slug);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body!.deletion).toMatchObject({ status: 'deleted' });
    expect(await shopRow(X.id)).toBeNull();
    const again = await del(pa.client, Y.id, Y.slug);
    expect([again.status, errCode(again)]).toEqual([403, 'mfa_step_up_required']);
    expect(await shopRow(Y.id)).toMatchObject({ status: 'active' });
  });

  it('a challenge is valid for 5 minutes; a new one needs a code typed after it', async () => {
    const { shop } = await liveShop();
    expect((await pf(pa.client, { action: 'shop-delete-challenge', shopId: shop.id })).status).toBe(200);
    await sql(`update private.shop_delete_challenges set created_at = now() - interval '6 minutes' where shop_id = '${shop.id}' and actor = '${pa.userId}';`);
    await verifyTotp(pa.client, pa.factorId!, pa.totpSecret!);
    const expired = await del(pa.client, shop.id, shop.slug);
    expect([expired.status, errCode(expired)]).toEqual([403, 'mfa_step_up_required']);

    // Opening the deletion again does not revive the code typed for the expired one.
    await sleep(OUTSIDE_TOLERANCE_MS);
    expect((await pf(pa.client, { action: 'shop-delete-challenge', shopId: shop.id })).status).toBe(200);
    expect(await sql(`select count(*) from private.shop_delete_challenges where shop_id = '${shop.id}';`)).toBe('1');
    const reopened = await del(pa.client, shop.id, shop.slug);
    expect([reopened.status, errCode(reopened)]).toEqual([403, 'mfa_step_up_required']);
    expect(await shopRow(shop.id)).toMatchObject({ status: 'active' });

    await verifyTotp(pa.client, pa.factorId!, pa.totpSecret!);
    const ok = await del(pa.client, shop.id, shop.slug);
    expect(ok.status, ok.text).toBe(200);
    expect(await shopRow(shop.id)).toBeNull();
  });

  it('the exact slug is required as well: a wrong one is refused even with a valid step-up', async () => {
    const { shop } = await liveShop();
    await stepUp(pa, shop.id);
    for (const wrong of [shop.slug.slice(0, -1), `${shop.slug}x`, shop.slug.toUpperCase(), 'yes']) {
      const res = await del(pa.client, shop.id, wrong);
      expect([wrong, res.status, errCode(res)]).toEqual([wrong, 400, 'confirmation_mismatch']);
    }
    expect(await shopRow(shop.id)).toMatchObject({ status: 'active' });
    expect(await audit(shop.id)).toBeNull();
  });

  it('the DEMO-only action still refuses a LIVE shop: no way around the step-up', async () => {
    const { shop } = await liveShop();
    await stepUp(pa, shop.id);
    const res = await pf(pa.client, { action: 'demo-delete', shopId: shop.id, confirmSlug: shop.slug });
    expect([res.status, errCode(res)]).toEqual([409, 'not_demo']);
    expect(await shopRow(shop.id)).toMatchObject({ status: 'active' });
  });
});

describe('preview', () => {
  it('shows what will be lost — catalog, orders, members, the bot with its audience and broadcasts — and changes nothing', async () => {
    const F = await populated();
    const res = await pf(pa.client, { action: 'shop-delete-preview', shopId: F.shop.id });
    expect(res.status, res.text).toBe(200);
    const p = res.body!.preview as Record<string, unknown>;
    expect(p).toMatchObject({
      status: 'ready',
      shop: { id: F.shop.id, slug: F.shop.slug, name: `IT ${F.shop.slug}`, is_demo: false, mode: 'live', status: 'active' },
      counts: { products: 1, categories: 1, variants: 2, images: 1, media_files: 3, orders: 1, members: 2, subscribers: 2, broadcasts: 1 },
      has_owner: true,
      notifications: true,
      bot: `mock_${botIdOf(F.token)}_bot`,
    });
    expect((p.members as Array<{ user_id: string; role: string }>).map((m) => [m.user_id, m.role]).sort()).toEqual(
      [[F.owner.userId, 'owner'], [F.manager.userId, 'manager']].sort(),
    );
    // Never a token, a chat id or a buyer's Telegram id.
    expect(res.text).not.toContain(F.token.split(':')[1]);
    expect(res.text).not.toContain(String(F.buyer));
    expect(await shopRow(F.shop.id)).toMatchObject({ status: 'active' });
    expect(await objectsUnder(`${F.shop.id}/`)).toHaveLength(3);
  });
});

describe('complete deletion of a LIVE shop', () => {
  let F: Fixture;
  let res: Awaited<ReturnType<typeof del>>;
  beforeAll(async () => {
    F = await populated();
    expect(await vaultSecrets(F.shop.id, 'shop_tg_notify')).not.toBe('0');
    expect(await vaultSecrets(F.shop.id, 'shop_tg_bot')).not.toBe('0');
    await stepUp(pa, F.shop.id);
    res = await del(pa.client, F.shop.id, F.shop.slug);
  });

  it('reports success only once everything is gone, and never returns the bot token', async () => {
    expect(res.status, res.text).toBe(200);
    expect(res.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(res.body?.storage).toEqual({ removed: 3, error: null });
    expect(res.text).not.toContain(F.token.split(':')[1]);
  });

  it('no row of the shop is left in any table; both Vault secrets, every file and the bot’s webhook are gone', async () => {
    await expectGone(F);
  });

  it('the bot of the deleted shop answers nobody: its former webhook is refused', async () => {
    const before = (await mockMessages(String(F.buyer))).length;
    const late = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${F.hook.connectionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': F.hook.secret },
      body: JSON.stringify({ update_id: 999_999_999, ...privateMessage(F.buyer, '/start') }),
    });
    expect(late.status).toBe(401);
    expect(await mockMessages(String(F.buyer))).toHaveLength(before);
  });

  it("neighbours are untouched: another shop's file, a look-alike name, the other shop itself", async () => {
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
    expect(await objectsUnder(F.lookalike)).toEqual([F.lookalike]);
    expect(await shopRow(F.other.id)).toMatchObject({ status: 'active' });
  });

  it('client accounts stay; only the memberships of the deleted shop are gone', async () => {
    for (const id of [F.owner.userId, F.manager.userId]) {
      const { data, error } = await admin.auth.admin.getUserById(id);
      expect(error).toBeNull();
      expect(data.user?.id).toBe(id);
    }
    const { data: m } = await admin.from('shop_memberships').select('shop_id, role').eq('user_id', F.owner.userId);
    expect(m).toEqual([{ shop_id: F.other.id, role: 'owner' }]);
    const { data: mm } = await admin.from('shop_memberships').select('shop_id').eq('user_id', F.manager.userId);
    expect(mm).toEqual([]);
    expect((await F.owner.client.rpc('is_shop_member', { p_shop_id: F.other.id })).data).toBe(true);
  });

  it('the audit row says it was a LIVE shop and when the code was verified', async () => {
    const a = await audit(F.shop.id);
    expect(a).toMatchObject({ slug: F.shop.slug, requested_by: pa.userId, was_demo: false, last_error: null });
    expect(a!.completed_at).not.toBeNull();
    expect(a!.step_up_at).not.toBeNull();
    // Verified before the deletion started, and not long before.
    const lead = Date.parse(a!.requested_at) - Date.parse(a!.step_up_at!);
    expect(lead).toBeGreaterThanOrEqual(-2000);
    expect(lead).toBeLessThan(60_000);
  });

  it('the old link shows "not found" and the slug can never be given to another shop', async () => {
    expect((await anon().from('shops').select('id').eq('slug', F.shop.slug)).data).toEqual([]);
    const inserted = await admin.from('shops').insert({ slug: F.shop.slug, name: 'Squatter', currency: 'RUB', theme_config: DARK_PREMIUM_THEME }).select('id');
    expect(inserted.error?.message).toBe('slug_taken');
  });

  it('repeating the deletion (or resuming it) is harmless, needs no new code and reports it as deleted', async () => {
    const again = await del(pa.client, F.shop.id, F.shop.slug);
    expect(again.status, again.text).toBe(200);
    expect(again.body?.deletion).toMatchObject({ status: 'deleted' });
    const resumed = await pf(pa.client, { action: 'demo-delete-resume', shopId: F.shop.id });
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body?.deletion).toMatchObject({ status: 'deleted' });
    const preview = await pf(pa.client, { action: 'shop-delete-preview', shopId: F.shop.id });
    expect(preview.body?.preview).toMatchObject({ status: 'deleted' });
    // A deleted shop cannot be "opened for deletion" again.
    const challenge = await pf(pa.client, { action: 'shop-delete-challenge', shopId: F.shop.id });
    expect([challenge.status, errCode(challenge)]).toEqual([404, 'shop_not_found']);
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
  });
});

describe('interrupted deletion of a LIVE shop', () => {
  it("'deleting': unreachable at once, the code is consumed, files are cleaned by the resume — no new code needed", async () => {
    const F = await populated();
    await stepUp(pa, F.shop.id);
    // Step 1 only (as if the Edge Function died right after the SQL transaction).
    const begun = await pa.svc.rpc('platform_shop_delete_begin', { p_actor: pa.userId, p_shop_id: F.shop.id, p_confirm_slug: F.shop.slug });
    expect(begun.error).toBeNull();
    expect(begun.data).toMatchObject({ status: 'pending' });

    expect(await shopRow(F.shop.id)).toMatchObject({ status: 'deleting' });
    expect((await anon().from('shops').select('id').eq('slug', F.shop.slug)).data).toEqual([]);
    expect((await F.owner.client.rpc('is_shop_member', { p_shop_id: F.shop.id })).data).toBe(false);
    expect(await leftovers(F.shop.id)).toEqual({});
    expect(await vaultSecrets(F.shop.id, 'shop_tg_bot')).toBe('0');
    expect(await objectsUnder(`${F.shop.id}/`)).toHaveLength(3);
    expect(await audit(F.shop.id)).toMatchObject({ was_demo: false, completed_at: null });
    // The owner's bot settings are closed with the shop.
    const closed = await botFn(F.owner.client, { action: 'get', shopId: F.shop.id });
    expect([closed.status, errCode(closed)]).toEqual([404, 'shop_not_found']);
    // Both dialogs report the unfinished deletion; the panel lists it as "deleting".
    expect((await pf(pa.client, { action: 'shop-delete-preview', shopId: F.shop.id })).body?.preview).toMatchObject({ status: 'deleting' });
    const list = await pf(pa.client, { action: 'list' });
    expect((list.body!.shops as Array<{ id: string; status: string }>).find((s) => s.id === F.shop.id)).toMatchObject({ status: 'deleting' });
    // Another admin, without any code of its own, may finish what was confirmed.
    const resumed = await pf(pb.client, { action: 'demo-delete-resume', shopId: F.shop.id });
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(resumed.body?.storage).toEqual({ removed: 3, error: null });
    expect(await shopRow(F.shop.id)).toBeNull();
    expect(await objectsUnder(`${F.shop.id}/`)).toEqual([]);
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
    expect(await audit(F.shop.id)).toMatchObject({ was_demo: false, last_error: null });
  });
});

describe('DEMO shops', () => {
  it('a DEMO shop with a connected bot can be deleted again (slug only, no step-up) — bot, audience and broadcasts included', async () => {
    const F = await populated({ demo: true });
    expect(await shopRow(F.shop.id)).toMatchObject({ is_demo: true });
    const res = await pf(pa.client, { action: 'demo-delete', shopId: F.shop.id, confirmSlug: F.shop.slug });
    expect(res.status, res.text).toBe(200);
    expect(res.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(res.body?.storage).toEqual({ removed: 3, error: null });
    await expectGone(F);
    expect(await audit(F.shop.id)).toMatchObject({ slug: F.shop.slug, requested_by: pa.userId, was_demo: true, step_up_at: null, last_error: null });
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
    expect(await objectsUnder(F.lookalike)).toEqual([F.lookalike]);
  });

  it('"Удалить магазин" asks for the step-up for a DEMO shop too', async () => {
    const demo = await createTestShop({ isDemo: true });
    // Outside the tolerance of any code verified earlier in this file.
    await sleep(OUTSIDE_TOLERANCE_MS);
    const refused = await del(pa.client, demo.id, demo.slug);
    expect([refused.status, errCode(refused)]).toEqual([403, 'mfa_step_up_required']);
    expect(await shopRow(demo.id)).toMatchObject({ status: 'active', is_demo: true });
    await stepUp(pa, demo.id);
    const ok = await del(pa.client, demo.id, demo.slug);
    expect(ok.status, ok.text).toBe(200);
    expect(await shopRow(demo.id)).toBeNull();
    const a = await audit(demo.id);
    expect(a).toMatchObject({ was_demo: true });
    expect(a!.step_up_at).not.toBeNull();
    // Still reserved: a DEMO cannot be recreated on the deleted slug.
    const template = await createTestShop({ isDemo: true });
    const created = await pf(pa.client, { action: 'create-demo', templateId: template.id, slug: demo.slug, name: 'Again' });
    if (created.status === 201) track('shop', (created.body!.shop as { id: string }).id);
    expect([created.status, errCode(created)]).toEqual([409, 'slug_taken']);
  });
});
