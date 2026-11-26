/** Supabase Auth allows one recovery mail per user per 60 s (hosted default); the button waits as long. */
export const RESEND_AFTER_SEC = 60;

/** Where the link of the recovery mail leads: the page that lets the user (signed in by that link) choose a new password. */
export const RECOVERY_REDIRECT_PATH = '/admin/set-password';

interface AuthLikeError {
  status?: number;
  code?: string;
}

/**
 * Human text for a refusal of resetPasswordForEmail. Success never says whether the account exists (the neutral notice
 * of the page), so this is only about sending limits and the restricted default mail service of Supabase.
 */
export function recoveryErrorText(error: AuthLikeError): string {
  if (error.status === 429 || error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
    return 'Письмо уже отправляли совсем недавно или исчерпан лимит отправки писем. Подождите минуту и повторите; если не получится — повторите через час или обратитесь к администратору платформы.';
  }
  if (error.code === 'email_address_not_authorized') {
    return 'Сейчас письма на этот адрес не отправляются: почтовый сервис платформы ограничен. Обратитесь к администратору платформы.';
  }
  return 'Не удалось отправить письмо. Повторите попытку позже.';
}
