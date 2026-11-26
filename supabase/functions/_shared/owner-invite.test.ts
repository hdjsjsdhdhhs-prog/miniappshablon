// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addressKey,
  clientAddress,
  generateInviteToken,
  hashInviteToken,
  INVITE_TOKEN_RE,
  isKnownRefusal,
  normalizeEmail,
  OWNER_INVITE_ERRORS,
  passwordProblem,
  sha256Hex,
} from './owner-invite';

describe('owner registration token', () => {
  it('is 256 random bits in base64url: 43 URL-safe characters, never repeated', () => {
    const tokens = Array.from({ length: 2000 }, () => generateInviteToken());
    for (const t of tokens) expect(t).toMatch(INVITE_TOKEN_RE);
    expect(new Set(tokens).size).toBe(tokens.length);
    // Every character position is used (a constant or truncated generator would not do that).
    const seen = new Set(tokens.flatMap((t) => [...t]));
    expect(seen.size).toBeGreaterThan(50);
  });

  it('decodes to exactly 32 bytes', () => {
    expect(Buffer.from(generateInviteToken(), 'base64url')).toHaveLength(32);
  });

  it('what the database stores is the SHA-256 of the token with a fixed prefix, never the token', async () => {
    const token = generateInviteToken();
    const hash = await hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(`owner-invite:${token}`).digest('hex'));
    expect(hash).not.toContain(token);
    expect(await hashInviteToken(token)).toBe(hash);
    expect(await hashInviteToken(`${token}x`)).not.toBe(hash);
    expect(await sha256Hex(token)).not.toBe(hash);
  });

  it('only a well-formed token is accepted by the format check', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, ' '.repeat(43), `${'a'.repeat(42)}\n`]) {
      expect(INVITE_TOKEN_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(INVITE_TOKEN_RE.test('a'.repeat(43))).toBe(true);
    expect(INVITE_TOKEN_RE.test('A-_9'.repeat(10) + 'abc')).toBe(true);
  });
});

describe('throttle key of the client address', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('prefers the proxy-set address, then the first forwarded one, then x-real-ip, then a shared bucket', () => {
    expect(clientAddress(h({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.7');
    expect(clientAddress(h({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
    expect(clientAddress(h({ 'x-real-ip': '192.0.2.5' }))).toBe('192.0.2.5');
    expect(clientAddress(h({}))).toBe('unknown');
  });

  it('bounds an absurd header and never stores the raw address (only its hash)', async () => {
    expect(clientAddress(h({ 'x-forwarded-for': 'x'.repeat(500) }))).toHaveLength(64);
    const key = await addressKey(h({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('203');
    expect(await addressKey(h({ 'cf-connecting-ip': '203.0.113.8' }))).not.toBe(key);
  });
});

describe('password and e-mail rules', () => {
  it('keeps the project policy: at least 10 characters, at most 72 bytes', () => {
    expect(passwordProblem('123456789')).toBe('too_short');
    expect(passwordProblem('1234567890')).toBeNull();
    expect(passwordProblem('x'.repeat(72))).toBeNull();
    expect(passwordProblem('x'.repeat(73))).toBe('too_long');
    // Counted in bytes, like bcrypt: 37 two-byte characters are 74 bytes.
    expect(passwordProblem('я'.repeat(37))).toBe('too_long');
    expect(passwordProblem('я'.repeat(36))).toBeNull();
  });

  it('normalises the e-mail the same way the database does (trim, lower case)', () => {
    expect(normalizeEmail('  Buyer@Example.COM ')).toBe('buyer@example.com');
  });
});

describe('SQL refusals', () => {
  it('maps the link states to distinct, non-leaking public codes', () => {
    expect(OWNER_INVITE_ERRORS.invite_used).toEqual([410, 'invite_used']);
    expect(OWNER_INVITE_ERRORS.invite_expired).toEqual([410, 'invite_expired']);
    expect(OWNER_INVITE_ERRORS.invite_revoked).toEqual([410, 'invite_revoked']);
    expect(OWNER_INVITE_ERRORS.invite_invalid).toEqual([404, 'invite_invalid']);
    expect(OWNER_INVITE_ERRORS.rate_limited).toEqual([429, 'rate_limited']);
    // An account that may not own a shop gets one neutral code whatever the reason (admin, blocked, unconfirmed).
    expect(new Set(['owner_is_platform_admin', 'owner_blocked', 'owner_unconfirmed'].map((k) => OWNER_INVITE_ERRORS[k]![1]))).toEqual(new Set(['owner_not_allowed']));
    // Every reservation conflict looks the same to the buyer: try again in a moment.
    for (const k of ['shop_busy', 'handover_in_progress', 'handover_reservation_lost', 'handover_reservation_mismatch']) {
      expect(OWNER_INVITE_ERRORS[k]).toEqual([409, 'invite_in_progress']);
    }
  });

  it('treats only a raised, known SQL exception as a rolled-back refusal (the account may then be removed)', () => {
    expect(isKnownRefusal('invite_used')).toBe(true);
    expect(isKnownRefusal('invite_unavailable')).toBe(true);
    // Unknown outcomes: transport / timeout / server errors must NEVER trigger the removal of an account.
    for (const message of ['', 'FetchError: network', 'TypeError: fetch failed', 'canceling statement due to statement timeout', 'JWT expired', 'toString', 'constructor', '__proto__']) {
      expect(isKnownRefusal(message), message).toBe(false);
    }
  });
});
