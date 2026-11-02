import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, totp } from './totp.ts';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"), 8 digits.
const SEED = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('T=%i → %s', (t, code) => {
    expect(hotp(SEED, Math.floor(t / 30), 8)).toBe(code);
  });

  it('decodes base32 secrets (RFC 4648) and computes 6-digit codes from them', () => {
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString('ascii')).toBe('12345678901234567890');
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
    expect(() => base32Decode('not-base32!')).toThrow();
  });
});
