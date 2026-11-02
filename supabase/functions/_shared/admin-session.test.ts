import { describe, expect, it } from 'vitest';
import { callerFromClaims, decodeJwtPayload, platformSessionHeaders } from './admin-session';

const USER = '11111111-2222-4333-8444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('admin MFA session', () => {
  it('decodes base64url JWT payloads and rejects malformed tokens', () => {
    expect(decodeJwtPayload(jwt({ sub: USER, aal: 'aal2', name: 'Ünïcode' }))).toEqual({ sub: USER, aal: 'aal2', name: 'Ünïcode' });
    expect(decodeJwtPayload('nope')).toBeNull();
    expect(decodeJwtPayload('h.%%%.s')).toBeNull();
    expect(decodeJwtPayload(jwt([1, 2]))).toBeNull();
  });

  it('forwards the session only for an aal2 token of the same user', () => {
    const aal2 = callerFromClaims(USER, { sub: USER, aal: 'aal2', session_id: SESSION });
    expect(aal2).toEqual({ userId: USER, aal: 'aal2', sessionId: SESSION });
    expect(platformSessionHeaders(aal2)).toEqual({ 'x-platform-session': SESSION });

    const aal1 = callerFromClaims(USER, { sub: USER, aal: 'aal1', session_id: SESSION });
    expect(aal1.aal).toBe('aal1');
    expect(platformSessionHeaders(aal1)).toEqual({});

    expect(platformSessionHeaders(callerFromClaims(USER, { sub: 'someone-else', aal: 'aal2', session_id: SESSION }))).toEqual({});
    expect(platformSessionHeaders(callerFromClaims(USER, { sub: USER, aal: 'aal2', session_id: 'not-a-uuid' }))).toEqual({});
    expect(platformSessionHeaders(callerFromClaims(USER, { sub: USER, aal: 'aal3', session_id: SESSION }))).toEqual({});
    expect(platformSessionHeaders(callerFromClaims(USER, null))).toEqual({});
  });
});
