-- The Vault secret of a shop's bot token lives exactly as long as its settings row: removing the settings
-- (owner "Отключить и удалить", or the shop being deleted → ON DELETE CASCADE) also erases the token.

create or replace function private.delete_notification_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.bot_token_secret_id;
  return null;
end;
$$;

revoke all on function private.delete_notification_secret() from public, anon, authenticated;

create trigger shop_notification_settings_delete_secret
  after delete on private.shop_notification_settings
  for each row execute function private.delete_notification_secret();
