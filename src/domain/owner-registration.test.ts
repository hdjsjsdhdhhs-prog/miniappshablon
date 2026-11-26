import { describe, expect, it } from 'vitest';
import { INVITE_TOKEN_RE, ownerLinkUrl, readInviteToken, registrationSchema, signInSchema } from './owner-registration';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordIssue } from './password';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_';

describe('owner registration link', () => {
  it('the token travels in the URL fragment, never in the path or the query', () => {
    expect(TOKEN).toMatch(INVITE_TOKEN_RE);
    const url = ownerLinkUrl(TOKEN, 'https://miniappdemo.pages.dev/');
    expect(url).toBe(`https://miniappdemo.pages.dev/admin/register#${TOKEN}`);
    const parsed = new URL(url);
    expect(parsed.search).toBe('');
    expect(parsed.pathname).toBe('/admin/register');
    expect(parsed.hash).toBe(`#${TOKEN}`);
  });

  it('reads a well-formed token from the hash and nothing else', () => {
    expect(readInviteToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(readInviteToken(TOKEN)).toBe(TOKEN);
    for (const bad of ['', '#', '#short', `#${TOKEN}x`, `#shop_id=1&${TOKEN}`, `#${TOKEN.slice(1)}`, '#access_token=abc']) {
      expect(readInviteToken(bad), bad).toBeNull();
    }
  });
});

describe('registration form rules', () => {
  const ok = { email: 'buyer@example.com', password: 'correct-horse-battery', repeat: 'correct-horse-battery' };

  it('accepts a valid e-mail and a matching, long enough password; trims the e-mail', () => {
    const parsed = registrationSchema.safeParse({ ...ok, email: '  buyer@example.com ' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBe('buyer@example.com');
  });

  it('requires the two passwords to match and shows it on the repeat field', () => {
    const r = registrationSchema.safeParse({ ...ok, repeat: 'correct-horse-battery!' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => [i.path.join('.'), i.message])).toContainEqual(['repeat', 'Пароли не совпадают']);
  });

  it('applies the project password policy (min 10 characters, max 72 bytes)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(registrationSchema.safeParse({ ...ok, password: '123456789', repeat: '123456789' }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...ok, password: '1234567890', repeat: '1234567890' }).success).toBe(true);
    const long = 'x'.repeat(MAX_PASSWORD_BYTES + 1);
    expect(registrationSchema.safeParse({ ...ok, password: long, repeat: long }).success).toBe(false);
    expect(passwordIssue('short')).toContain('10');
  });

  it('rejects a missing or malformed e-mail with a readable message', () => {
    for (const email of ['', '   ', 'plain', 'a@b', '@example.com', 'two words@example.com']) {
      const r = registrationSchema.safeParse({ ...ok, email });
      expect(r.success, email).toBe(false);
      expect(r.error?.issues.some((i) => i.path[0] === 'email' && /почт/i.test(i.message)), email).toBe(true);
    }
  });

  it('the sign-in form for an existing account needs an e-mail and a password, with no strength rule', () => {
    expect(signInSchema.safeParse({ email: 'buyer@example.com', password: 'x' }).success).toBe(true);
    expect(signInSchema.safeParse({ email: 'buyer@example.com', password: '' }).success).toBe(false);
    expect(signInSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });
});
