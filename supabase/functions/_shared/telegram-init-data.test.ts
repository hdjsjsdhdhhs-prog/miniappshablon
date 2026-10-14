// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDataCheckString, InitDataError, signInitData, validateInitData } from './telegram-init-data';

const TOKEN = '123456789:TEST_TOKEN_FOR_UNIT_TESTS_ONLY_xxxxx';
const NOW = 1_760_000_000;
const user = JSON.stringify({ id: 42, first_name: 'Ann', username: 'ann' });

/** Independent reference implementation with node:crypto (official algorithm). */
function referenceHash(params: URLSearchParams, token: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return createHmac('sha256', secret).update(buildDataCheckString(params)).digest('hex');
}

async function make(fields: Record<string, string> = {}) {
  return signInitData({ auth_date: String(NOW - 10), query_id: 'AAE', user, ...fields }, TOKEN);
}

describe('validateInitData', () => {
  it('accepts correctly signed data and matches the reference HMAC implementation', async () => {
    const raw = await make({ signature: 'abc' });
    const params = new URLSearchParams(raw);
    expect(params.get('hash')).toBe(referenceHash(params, TOKEN));
    const res = await validateInitData(raw, TOKEN, { maxAgeSec: 3600, nowSec: NOW });
    expect(res.user.id).toBe(42);
    expect(res.authDate).toBe(NOW - 10);
  });

  it('data_check_string is sorted, newline-joined and excludes only hash', () => {
    const p = new URLSearchParams('user=u&hash=h&auth_date=1&a=2');
    expect(buildDataCheckString(p)).toBe('a=2\nauth_date=1\nuser=u');
  });

  const reject = async (raw: string | null, code: string, token = TOKEN) => {
    await expect(validateInitData(raw, token, { maxAgeSec: 3600, nowSec: NOW })).rejects.toMatchObject({ code });
  };

  it('rejects tampered user data (e.g. forged user.id)', async () => {
    const raw = await make();
    const p = new URLSearchParams(raw);
    p.set('user', JSON.stringify({ id: 1, first_name: 'Mallory' }));
    await reject(p.toString(), 'bad_signature');
  });

  it('rejects data signed with another bot token', async () => {
    await reject(await make(), 'bad_signature', '987654321:OTHER_TOKEN_xxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('rejects expired and future-dated auth_date', async () => {
    await reject(await make({ auth_date: String(NOW - 7200) }), 'expired');
    await reject(await make({ auth_date: String(NOW + 3600) }), 'from_future');
  });

  it('rejects missing/malformed input and missing user', async () => {
    await reject(null, 'missing');
    await reject('', 'missing');
    await reject('user=1&auth_date=1', 'malformed');
    await reject(await signInitData({ auth_date: String(NOW) }, TOKEN), 'no_user');
    await reject(await signInitData({ auth_date: String(NOW), user: '{"id":"42"}' }, TOKEN), 'no_user');
  });

  it('throws a configuration error (not InitDataError) without a bot token', async () => {
    const err = await validateInitData(await make(), '', { maxAgeSec: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InitDataError);
  });
});
