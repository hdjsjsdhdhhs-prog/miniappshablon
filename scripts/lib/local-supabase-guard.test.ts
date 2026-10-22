// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertDevServerUsesSupabase,
  assertLocalSupabaseEnv,
  assertResolvedLocal,
  extractServedSupabaseUrl,
  isLocalSupabaseUrl,
  RemoteSupabaseError,
} from './local-supabase-guard.ts';

const LOCAL = 'http://127.0.0.1:54321';
const HOSTED = 'https://xyzcompany.supabase.co';
const localKeys = { SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };

const served = (url: string) =>
  `import.meta.env = {"BASE_URL": "/", "DEV": true, "VITE_SUPABASE_ANON_KEY": "anon", "VITE_SUPABASE_URL": "${url}"};function read(name) {}`;
const fakeFetch = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('isLocalSupabaseUrl', () => {
  it.each([LOCAL, 'http://localhost:54321', 'http://[::1]:54321/', 'https://127.0.0.1'])('accepts %s', (url) => {
    expect(isLocalSupabaseUrl(url)).toBe(true);
  });

  it.each([
    HOSTED,
    'https://localhost.evil.example',
    'https://evil.example/?h=127.0.0.1',
    'http://127.0.0.1.nip.io:54321',
    'http://user:pw@127.0.0.1:54321',
    'ftp://127.0.0.1',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isLocalSupabaseUrl(url)).toBe(false);
  });
});

describe('assertLocalSupabaseEnv', () => {
  it('allows an empty environment (local stack via `supabase status`)', () => {
    expect(() => assertLocalSupabaseEnv({})).not.toThrow();
  });

  it('allows an explicit local SUPABASE_URL with its keys and a matching VITE_SUPABASE_URL', () => {
    expect(() => assertLocalSupabaseEnv({ SUPABASE_URL: LOCAL, VITE_SUPABASE_URL: `${LOCAL}/`, ...localKeys })).not.toThrow();
  });

  it('rejects a hosted SUPABASE_URL', () => {
    expect(() => assertLocalSupabaseEnv({ SUPABASE_URL: HOSTED, ...localKeys })).toThrow(/SUPABASE_URL указывает не на локальный Supabase/);
  });

  it('rejects a hosted VITE_SUPABASE_URL', () => {
    expect(() => assertLocalSupabaseEnv({ VITE_SUPABASE_URL: HOSTED })).toThrow(RemoteSupabaseError);
  });

  it('rejects local URLs that disagree', () => {
    expect(() => assertLocalSupabaseEnv({ SUPABASE_URL: LOCAL, VITE_SUPABASE_URL: 'http://127.0.0.1:64321', ...localKeys })).toThrow(/различаются/);
  });

  it('rejects a service role key without SUPABASE_URL', () => {
    expect(() => assertLocalSupabaseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service' })).toThrow(/без локального SUPABASE_URL/);
  });

  it('rejects SUPABASE_URL without keys (scripts would silently use another project)', () => {
    expect(() => assertLocalSupabaseEnv({ SUPABASE_URL: LOCAL })).toThrow(/неясно/);
  });

  it.each(['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF'])('rejects hosted CLI credential %s', (name) => {
    expect(() => assertLocalSupabaseEnv({ [name]: 'x' })).toThrow(new RegExp(name));
  });
});

describe('assertResolvedLocal', () => {
  it('accepts the local stack', () => {
    expect(() => assertResolvedLocal({ url: LOCAL, isLocal: true })).not.toThrow();
  });

  it('rejects a hosted URL even if flagged local by a loose check', () => {
    expect(() => assertResolvedLocal({ url: 'https://localhost.evil.example', isLocal: true })).toThrow(RemoteSupabaseError);
    expect(() => assertResolvedLocal({ url: HOSTED, isLocal: false })).toThrow(RemoteSupabaseError);
  });
});

describe('dev server check', () => {
  it('extracts VITE_SUPABASE_URL from a Vite-served module', () => {
    expect(extractServedSupabaseUrl(served(LOCAL))).toBe(LOCAL);
    expect(extractServedSupabaseUrl('export const x = 1;')).toBeNull();
  });

  it('accepts a dev server that injects the local URL', async () => {
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, fakeFetch(served(`${LOCAL}/`)))).resolves.toBeUndefined();
  });

  it('rejects a dev server that injects a hosted URL', async () => {
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, fakeFetch(served(HOSTED)))).rejects.toThrow(/не локальный Supabase/);
  });

  it('rejects a dev server bound to a different local stack', async () => {
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, fakeFetch(served('http://127.0.0.1:64321')))).rejects.toThrow(/тестовые данные/);
  });

  it('rejects a foreign server and an unreachable one', async () => {
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, fakeFetch('<html></html>'))).rejects.toThrow(/не сообщил/);
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, fakeFetch('', 404))).rejects.toThrow(/HTTP 404/);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(assertDevServerUsesSupabase('http://127.0.0.1:5183', LOCAL, down)).rejects.toThrow(/fetch failed/);
  });
});
