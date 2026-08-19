// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  createSessionJwtMinter,
  deriveSessionKey,
  signTransientCookie,
  verifyTransientCookie,
} from '../session-jwt.js';

const SECRET = 'test-client-secret-with-enough-entropy';

describe('deriveSessionKey (ADR-0062)', () => {
  it('derives distinct deterministic keys per info label', () => {
    const a = deriveSessionKey(SECRET, 'session-jwt');
    const b = deriveSessionKey(SECRET, 'pkce-cookie');
    expect(a).not.toEqual(b);
    expect(deriveSessionKey(SECRET, 'session-jwt')).toEqual(a);
  });

  it('derives different keys for different client secrets', () => {
    expect(deriveSessionKey(SECRET, 'session-jwt')).not.toEqual(
      deriveSessionKey(SECRET + '-rotated', 'session-jwt'),
    );
  });
});

describe('createSessionJwtMinter', () => {
  const { mint, verify } = createSessionJwtMinter(SECRET, 8);

  it('mints a session the verifier accepts', async () => {
    const token = await mint({ sub: 'user-1', tenantId: 'org-42', role: 'admin' });
    expect(token).toBeTruthy();
    await expect(verify(token)).resolves.toEqual({
      sub: 'user-1',
      tenantId: 'org-42',
      role: 'admin',
    });
  });

  it('accepts claims without tenant/role', async () => {
    const token = await mint({ sub: 'user-2' });
    await expect(verify(token)).resolves.toEqual({ sub: 'user-2' });
  });

  it('rejects tampered tokens', async () => {
    const token = await mint({ sub: 'user-1' });
    const [header, , sig] = token.split('.');
    expect(sig).toBeTruthy();
    const tampered = [
      header,
      Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url'),
      sig,
    ].join('.');
    await expect(verify(tampered)).resolves.toBeNull();
  });

  it('rejects tokens signed with a different secret (rotation invalidates)', async () => {
    const other = createSessionJwtMinter(SECRET + '-rotated', 8);
    const token = await other.mint({ sub: 'user-1' });
    await expect(verify(token)).resolves.toBeNull();
  });
});

describe('signTransientCookie / verifyTransientCookie', () => {
  it('round-trips a signed value', () => {
    const signed = signTransientCookie(SECRET, 'state.verifier.1780000000000');
    expect(verifyTransientCookie(SECRET, signed)).toBe('state.verifier.1780000000000');
  });

  it('rejects a tampered value', () => {
    const signed = signTransientCookie(SECRET, 'state.verifier.1780000000000');
    const tampered =
      'state.verifier.0' + signed.slice(signed.indexOf('.', signed.indexOf('.') + 1));
    expect(verifyTransientCookie(SECRET, tampered)).toBeNull();
  });

  it('rejects a value signed with a different secret', () => {
    const signed = signTransientCookie(SECRET + '-other', 'state.verifier.1780000000000');
    expect(verifyTransientCookie(SECRET, signed)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyTransientCookie(SECRET, 'no-dots-here')).toBeNull();
    expect(verifyTransientCookie(SECRET, '.')).toBeNull();
  });
});
