/**
 * Reads the (unverified) user object from raw initData for DISPLAY and cache-key purposes only.
 * Authorization never relies on this: Edge Functions verify the signature and derive the user.
 */
export function unverifiedTelegramUser(raw: string | null): { id: number | null; firstName: string } {
  if (!raw) return { id: null, firstName: '' };
  try {
    const user = JSON.parse(new URLSearchParams(raw).get('user') ?? '{}') as { id?: number; first_name?: string };
    return { id: typeof user.id === 'number' ? user.id : null, firstName: user.first_name ?? '' };
  } catch {
    return { id: null, firstName: '' };
  }
}
