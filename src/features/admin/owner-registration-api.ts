import type { InvitePreviewStatus } from '@/domain/owner-registration';
import { env } from '@/lib/env';
import { functionsUrl } from '@/lib/supabase';

/**
 * Buyer side of the owner registration link: the public Edge Function `owner-registration`. The token is sent only in
 * the POST body (never in a URL, header or query string) and the request is neither cached nor given a referrer.
 * The browser holds no secret of the platform; the session after registration comes from Supabase Auth (signIn).
 */
export class OwnerRegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSec: number | null = null,
    readonly details: unknown = null,
  ) {
    super(code);
  }
}

async function call<T>(body: Record<string, unknown>, bearer?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(functionsUrl('owner-registration'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.supabaseAnonKey, Authorization: `Bearer ${bearer ?? env.supabaseAnonKey}` },
      body: JSON.stringify(body),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new OwnerRegistrationError(0, 'network_error');
  }
  const json = (await res.json().catch(() => null)) as ({ error?: { code?: string; details?: unknown } } & T) | null;
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'));
    throw new OwnerRegistrationError(res.status, json?.error?.code ?? 'unknown_error', Number.isFinite(retry) && retry > 0 ? retry : null, json?.error?.details ?? null);
  }
  return json as T;
}

export interface InvitePreview {
  status: InvitePreviewStatus;
  shop?: { name: string; logo_path: string | null };
  /** The link was issued for one e-mail address only. The address itself is never sent. */
  email_bound?: boolean;
  expires_at?: string;
}

export interface OwnershipResult {
  status: 'completed';
  via: 'registration' | 'claim';
  shop: { slug: string; name: string };
}

export const ownerRegistrationApi = {
  preview: (token: string) => call<{ invite: InvitePreview }>({ action: 'preview', token }).then((r) => r.invite),
  /** Creates the account and makes it the owner. Repeating the request is safe: a second one never creates a second account. */
  register: (token: string, input: { email: string; password: string; passwordConfirm: string }) =>
    call<OwnershipResult>({ action: 'register', token, ...input }),
  /** Applies the link to the account of `accessToken` (an existing, signed-in account). */
  claim: (token: string, accessToken: string) => call<OwnershipResult>({ action: 'claim', token }, accessToken),
};

const ERRORS: Record<string, string> = {
  invite_invalid: 'Ссылка недействительна. Проверьте, что вы открыли её целиком, или попросите новую.',
  invite_expired: 'Срок действия ссылки истёк. Попросите новую у администратора платформы.',
  invite_revoked: 'Ссылка отозвана. Попросите новую у администратора платформы.',
  invite_used: 'Ссылка уже использована. Если регистрировались вы — просто войдите со своей почтой и паролем.',
  invite_unavailable: 'Ссылка больше не действует: магазин изменился. Попросите новую у администратора платформы.',
  invite_in_progress: 'По этой ссылке уже идёт регистрация. Подождите минуту и повторите.',
  invite_email_mismatch: 'Эта ссылка выдана для другого адреса электронной почты.',
  account_exists: 'Аккаунт с этой почтой уже есть. Войдите в него — ссылка применится к этому аккаунту.',
  owner_not_allowed: 'Этот аккаунт не может стать владельцем магазина.',
  password_mismatch: 'Пароли не совпадают.',
  weak_password: 'Пароль слишком простой. Выберите другой — не короче 10 символов.',
  invalid_body: 'Проверьте электронную почту и пароль.',
  auth_required: 'Сессия истекла. Войдите снова.',
  network_error: 'Нет связи с сервером. Проверьте интернет и нажмите кнопку ещё раз — повторная отправка безопасна, второй аккаунт не создаётся.',
  auth_unavailable: 'Сервис входа временно недоступен. Повторите через минуту — повторная отправка безопасна.',
};

function wait(seconds: number | null): string {
  if (!seconds) return 'позже';
  return seconds >= 120 ? `через ${Math.ceil(seconds / 60)} мин` : `через ${seconds} с`;
}

/** Human text for an error of the buyer's page. Never a technical description, never the token. */
export function ownerRegistrationErrorText(error: unknown): string {
  if (!(error instanceof OwnerRegistrationError)) return 'Не удалось выполнить действие. Повторите попытку.';
  if (error.code === 'rate_limited') return `Слишком много попыток. Повторите ${wait(error.retryAfterSec)}.`;
  return ERRORS[error.code] ?? 'Не удалось выполнить действие. Повторите попытку — повторная отправка безопасна.';
}

/** After these the outcome on the server is unknown: the request may have been completed. */
export function isUncertainOutcome(error: unknown): boolean {
  return error instanceof OwnerRegistrationError && (error.status === 0 || error.status >= 500 || error.code === 'invite_in_progress');
}
