// pnpm owner:add --slug <slug> --email <email> [--role owner|manager]
// Creates (or reuses) a Supabase Auth user and grants membership in one shop.
// Password: OWNER_PASSWORD env var, otherwise a random one is generated and printed ONCE.
// Public sign-up is disabled; this platform-admin command is the controlled way to add owners.
//
// pnpm owner:add --email <email> --platform-admin   -> grants platform admin rights.
import { randomBytes } from 'node:crypto';
import { fail, hasFlag, log, parseArgs, requireString, run } from './lib/cli.ts';
import { serviceClient } from './lib/supabase-env.ts';

async function findUserByEmail(db: ReturnType<typeof serviceClient>, email: string) {
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

run(async () => {
  const args = parseArgs();
  const email = requireString(args, 'email');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Некорректный email');
  const platformAdmin = hasFlag(args, 'platform-admin');
  const slug = platformAdmin ? null : requireString(args, 'slug');
  const role = typeof args.flags.role === 'string' ? args.flags.role : 'owner';
  if (!['owner', 'manager'].includes(role)) fail('--role: owner | manager');

  const db = serviceClient();
  let user = await findUserByEmail(db, email);
  let generated: string | null = null;
  if (!user) {
    const password = process.env.OWNER_PASSWORD ?? (generated = randomBytes(12).toString('base64url'));
    if (password.length < 10) fail('OWNER_PASSWORD должен быть не короче 10 символов');
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    user = data.user;
    log.ok(`Создан пользователь ${email}`);
  } else {
    log.info(`Пользователь ${email} уже существует — пароль не меняется`);
  }

  if (platformAdmin) {
    const { error } = await db.from('platform_admins').upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    log.ok(`${email}: администратор платформы`);
  } else {
    const { data: shop, error } = await db.from('shops').select('id').eq('slug', slug!).maybeSingle();
    if (error) throw new Error(error.message);
    if (!shop) fail(`Магазин ${slug} не найден`);
    const { error: me } = await db
      .from('shop_memberships')
      .upsert({ shop_id: shop.id, user_id: user.id, role }, { onConflict: 'shop_id,user_id', ignoreDuplicates: true });
    if (me) throw new Error(me.message);
    log.ok(`${email}: ${role} магазина ${slug}`);
  }
  if (generated) {
    log.warn(`Временный пароль (показан один раз, передайте владельцу защищённым каналом): ${generated}`);
  }
  return 0;
});
