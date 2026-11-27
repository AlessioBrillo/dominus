// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { toApplicationServerKey } from '../web-push';

describe('toApplicationServerKey', () => {
  it('decodes an unpadded base64url VAPID key into raw bytes', () => {
    // "AQID" is the base64url encoding of the bytes 1, 2, 3.
    const key = toApplicationServerKey('AQID');
    expect(new Uint8Array(key)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('handles the URL-safe alphabet and missing padding', () => {
    // "-_8=" encodes 0xfb, 0xff: the URL-safe characters must become + and /.
    const key = toApplicationServerKey('-_8');
    expect(new Uint8Array(key)).toEqual(new Uint8Array([0xfb, 0xff]));
  });
});
