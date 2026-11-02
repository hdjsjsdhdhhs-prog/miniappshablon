-- Recovery of a platform admin who lost the authenticator (pnpm platform-admin:mfa-reset, scripts/lib/mfa-reset.ts).
--
-- The operator removes the admin's MFA factors through the standard Supabase Auth Admin API and then ends EVERY
-- session of that account with this function. Ending the sessions matters: auth.sessions keeps aal = 'aal2' for a
-- session that once verified a code, so without it an old session (e.g. on the lost device) would count as aal2
-- again as soon as the admin enrolled a new factor (private.session_is_aal2, 20261102090000).
--
-- Nothing is opened by it: with no verified factor and no session the account can only sign in with the password
-- (aal1) and enroll + verify a new factor; until then every platform right is refused (mfa_required). There is no
-- bypass flag and no lasting exception. The Auth Admin API has no "sign out user by id", hence this function.
-- Service role only (operators / scripts); it acts only on platform admin accounts.

select set_config('lock_timeout', '5s', true);

create or replace function public.platform_admin_revoke_sessions(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or not private.is_platform_admin_user(p_user_id) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  -- Refresh tokens and MFA AMR claims of these sessions go with them (ON DELETE CASCADE in the auth schema).
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.platform_admin_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.platform_admin_revoke_sessions(uuid) to service_role;
