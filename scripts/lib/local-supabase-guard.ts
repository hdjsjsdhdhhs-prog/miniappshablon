/**
 * Fail-closed guards for test runs that write data (E2E seed/publish, owner accounts, orders).
 * They must only ever reach the LOCAL Supabase stack: a hosted URL in the shell, an ambiguous mix of
 * variables or a dev server that talks to another project stops the run before any data operation.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Supabase URL variables the project reads (scripts and the Vite app). */
export const SUPABASE_URL_VARS = ['SUPABASE_URL', 'VITE_SUPABASE_URL'] as const;

/** Hosted-project credentials for the Supabase CLI. Nothing in a local test run needs them. */
export const HOSTED_CREDENTIAL_VARS = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF'] as const;

export class RemoteSupabaseError extends Error {
  override name = 'RemoteSupabaseError';
}

/** True only for http(s) URLs whose host is the loopback interface (no lookalike hosts, no credentials). */
export function isLocalSupabaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password;
}

function origin(value: string): string {
  return new URL(value).origin;
}

/**
 * Refuses an environment that could point a test run at a hosted project: a non-local Supabase URL,
 * URL variables that disagree, a service role key without a local SUPABASE_URL, or hosted CLI credentials.
 */
export function assertLocalSupabaseEnv(env: Record<string, string | undefined> = process.env): void {
  const problems: string[] = [];
  const urls: string[] = [];
  for (const name of SUPABASE_URL_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (isLocalSupabaseUrl(value)) urls.push(origin(value));
    else problems.push(`${name} указывает не на локальный Supabase: ${value}`);
  }
  if (new Set(urls).size > 1) problems.push(`SUPABASE_URL и VITE_SUPABASE_URL различаются: ${urls.join(' ≠ ')}`);
  const hasUrl = Boolean(env.SUPABASE_URL?.trim());
  const hasServiceKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  if (hasServiceKey && !hasUrl) problems.push('SUPABASE_SERVICE_ROLE_KEY задан без локального SUPABASE_URL');
  if (hasUrl && (!hasServiceKey || !env.SUPABASE_ANON_KEY?.trim())) {
    problems.push('SUPABASE_URL задан без SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY: неясно, какой проект использовать');
  }
  for (const name of HOSTED_CREDENTIAL_VARS) {
    if (env[name]?.trim()) problems.push(`${name} задан (учётные данные hosted-проекта)`);
  }
  if (problems.length) {
    throw new RemoteSupabaseError(
      `Тесты работают только с локальным Supabase (pnpm db:start). Запуск остановлен до seed, publish и создания пользователей:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nУберите эти переменные из окружения этого запуска.`,
    );
  }
}

/** Checks the URL the scripts actually resolved (SUPABASE_URL or `supabase status`). */
export function assertResolvedLocal(env: { url: string; isLocal: boolean }): void {
  if (!env.isLocal || !isLocalSupabaseUrl(env.url)) {
    throw new RemoteSupabaseError(`Тесты работают только с локальным Supabase, получен ${env.url}`);
  }
}

/** Reads VITE_SUPABASE_URL from a module served by the Vite dev server (`import.meta.env = {...};`). */
export function extractServedSupabaseUrl(source: string): string | null {
  const match = /import\.meta\.env\s*=\s*(\{.*?\});/s.exec(source);
  if (!match) return null;
  try {
    const value = (JSON.parse(match[1]!) as Record<string, unknown>).VITE_SUPABASE_URL;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Asks the dev server the browser will use which Supabase URL it injects into the app and requires it
 * to be the local stack the test data is written to. Any doubt (unreachable, unparsable) is a failure.
 */
export async function assertDevServerUsesSupabase(
  baseUrl: string,
  expectedUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const moduleUrl = new URL('/src/lib/env.ts', baseUrl).href;
  let source: string;
  try {
    const res = await fetchImpl(moduleUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    source = await res.text();
  } catch (err) {
    throw new RemoteSupabaseError(`Не удалось проверить Supabase URL dev-сервера (${moduleUrl}): ${(err as Error).message}`);
  }
  const served = extractServedSupabaseUrl(source);
  if (!served) throw new RemoteSupabaseError(`Dev-сервер ${baseUrl} не сообщил VITE_SUPABASE_URL: это не ожидаемый Vite-сервер приложения`);
  if (!isLocalSupabaseUrl(served)) throw new RemoteSupabaseError(`Dev-сервер ${baseUrl} использует не локальный Supabase: ${served}`);
  if (origin(served) !== origin(expectedUrl)) {
    throw new RemoteSupabaseError(`Dev-сервер ${baseUrl} использует ${served}, а тестовые данные пишутся в ${expectedUrl}`);
  }
}
