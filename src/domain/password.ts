/**
 * Password rules of the platform. The numbers mirror Supabase Auth ([auth] minimum_password_length in
 * supabase/config.toml, no character-class requirements); Auth enforces them again on the server.
 */
export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt (Supabase Auth) ignores everything after byte 72, so a longer password is refused instead of truncated. */
export const MAX_PASSWORD_BYTES = 72;

export function passwordIssue(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Пароль — не короче ${MIN_PASSWORD_LENGTH} символов.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return `Пароль слишком длинный (не более ${MAX_PASSWORD_BYTES} байт).`;
  return null;
}
