import { describe, it, expect } from 'vitest';
import { isDefinitelyNotBroadcast } from '../attestation.js';

describe('isDefinitelyNotBroadcast', () => {
  it('treats wallet user rejection as not broadcast', () => {
    const e = Object.assign(new Error('User rejected'), { name: 'UserRejectedRequestError' });
    expect(isDefinitelyNotBroadcast(e)).toBe(true);
    expect(isDefinitelyNotBroadcast({ code: 4001 })).toBe(true);
    expect(isDefinitelyNotBroadcast(Object.assign(new Error('wrap'), { cause: e }))).toBe(true);
  });
  it('treats network/timeout/RPC errors as possibly broadcast', () => {
    expect(isDefinitelyNotBroadcast(new Error('fetch failed'))).toBe(false);
    expect(isDefinitelyNotBroadcast(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(false);
    expect(isDefinitelyNotBroadcast(undefined)).toBe(false);
  });
});
