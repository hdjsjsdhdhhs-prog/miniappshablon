// pnpm platform-admin:mfa-reset --email <email> --confirm <email>
// Recovery of a platform admin who lost the authenticator app: removes the account's MFA factors (Supabase Auth
// Admin API) and ends every session of the account (scripts/lib/mfa-reset.ts). Nothing else changes: the admin signs
// in with the password and must enroll a new TOTP factor; until it is verified every platform right is refused.
// Only for accounts in public.platform_admins. Target project: SUPABASE_URL + keys from the shell, otherwise local.
// This command is THE recovery procedure: it is the only supported way to restore access, because it removes the
// factors and revokes every session in one step, so no session from before the reset survives it. Before running it,
// verify the admin's identity out of band. If the password may be compromised as well, reset the password FIRST (Supabase
// Dashboard → Authentication → Users), otherwise whoever knows it could enroll their own factor right after the reset.
// Do NOT recover by deleting the factor in the Dashboard alone: that keeps the account's sessions, and auth.sessions
// still says aal2 for them, so an old session (e.g. on the lost device) is valid again once a new factor is verified.
// If that happened, run this command at once — it ends every session of the account.
import { fail, log, parseArgs, requireString, run } from './lib/cli.ts';
import { findUserIdByEmail, resetPlatformAdminMfa } from './lib/mfa-reset.ts';
import { resolveSupabaseEnv, serviceClient } from './lib/supabase-env.ts';

run(async () => {
  const args = parseArgs();
  const email = requireString(args, 'email').trim().toLowerCase();
  const confirm = typeof args.flags.confirm === 'string' ? args.flags.confirm.trim().toLowerCase() : '';
  if (confirm !== email) fail('Подтвердите сброс: --confirm <тот же email>');

  const env = resolveSupabaseEnv();
  log.info(`Проект: ${env.url}${env.isLocal ? ' (локальный)' : ''}`);
  const db = serviceClient();
  const userId = await findUserIdByEmail(db, email);
  if (!userId) fail(`Пользователь ${email} не найден`);
  const res = await resetPlatformAdminMfa(db, userId);
  log.ok(`${email}: удалено MFA-факторов — ${res.factorsRemoved}, завершено сессий — ${res.sessionsRevoked}`);
  log.warn('Администратор входит по паролю и обязан заново подключить приложение-аутентификатор (aal2) до любых действий.');
  return 0;
});
