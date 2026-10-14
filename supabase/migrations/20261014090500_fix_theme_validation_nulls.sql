-- Fix: is_valid_theme() accepted themes with MISSING keys.
-- `jsonb_typeof(NULL) <> 'string'` evaluates to NULL and `IF NULL THEN` is false in PL/pgSQL,
-- so absent colors/mode/radius passed the CHECK constraint. Found by tests/integration/rls.test.ts.

create or replace function public.is_valid_theme(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  color_keys constant text[] := array[
    'background','foreground','card','cardForeground','primary','primaryForeground',
    'accent','accentForeground','muted','mutedForeground','border'
  ];
  k text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (color_keys) or k in ('mode','radius')) then
      return false;
    end if;
  end loop;
  foreach k in array color_keys loop
    if jsonb_typeof(p -> k) is distinct from 'string'
       or coalesce(p ->> k, '') !~ '^#[0-9a-fA-F]{6}$' then
      return false;
    end if;
  end loop;
  if coalesce(p ->> 'mode', '') not in ('dark','light') then
    return false;
  end if;
  if jsonb_typeof(p -> 'radius') is distinct from 'number'
     or (p ->> 'radius')::numeric not between 0 and 28 then
    return false;
  end if;
  return true;
end;
$$;

-- Existing rows must satisfy the corrected rule (CHECK constraints are not re-evaluated on
-- function replacement). Fail loudly instead of silently keeping invalid data.
do $$
begin
  if exists (select 1 from public.shops where not public.is_valid_theme(theme_config)) then
    raise exception 'shops with invalid theme_config exist; fix them before applying this migration';
  end if;
end;
$$;
