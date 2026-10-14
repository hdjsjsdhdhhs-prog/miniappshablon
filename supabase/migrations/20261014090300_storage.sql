-- Storage: one bucket for storefront media. Object names are "<shop_id>/<entity>/<entity_id>/<file>".
-- Public read via public URL is intended only for storefront images (logos, covers, products,
-- categories); private data is never stored in this bucket. Listing and every write are restricted
-- to members of the shop encoded in the first path segment.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-media', 'shop-media', true, 5242880, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.storage_object_shop_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_first text := split_part(p_name, '/', 1);
begin
  if v_first ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_first::uuid;
  end if;
  return null;
end;
$$;

revoke all on function public.storage_object_shop_id(text) from public;
grant execute on function public.storage_object_shop_id(text) to anon, authenticated, service_role;

create policy shop_media_member_select on storage.objects
  for select to authenticated
  using (bucket_id = 'shop-media' and public.is_shop_member(public.storage_object_shop_id(name)));

create policy shop_media_member_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'shop-media' and public.is_shop_member(public.storage_object_shop_id(name)));

create policy shop_media_member_update on storage.objects
  for update to authenticated
  using (bucket_id = 'shop-media' and public.is_shop_member(public.storage_object_shop_id(name)))
  with check (bucket_id = 'shop-media' and public.is_shop_member(public.storage_object_shop_id(name)));

create policy shop_media_member_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'shop-media' and public.is_shop_member(public.storage_object_shop_id(name)));
