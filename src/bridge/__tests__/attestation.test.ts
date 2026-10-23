import { describe, it, expect, vi, afterEach } from 'vitest';
import { attestationUrl, parseAttestationResponse } from '../attestation.js';
import { BridgeModule, BridgeError } from '../client.js';

const fail = (m: string): never => { throw new Error(m); };
const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

describe('#44 CCTP V2 attestation lookup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Circle V2 transactionHash query, not /messages/{domain}/{hash}', () => {
    expect(attestationUrl('https://iris-api.circle.com/', 6, TX))
      .toBe(`https://iris-api.circle.com/v2/messages/6?transactionHash=${TX}`);
  });

  it('treats empty / PENDING responses as pending', () => {
    expect(parseAttestationResponse({}, fail)).toBe('pending');
    expect(parseAttestationResponse({ messages: [{ status: 'pending_confirmations', attestation: 'PENDING', message: '0x' }] }, fail)).toBe('pending');
  });

  it('returns Circle attested message + attestation when complete', () => {
    expect(parseAttestationResponse({ messages: [{ status: 'complete', attestation: '0xaa', message: '0xbb' }] }, fail))
      .toEqual({ message: '0xbb', attestation: '0xaa' });
  });

  it('throws on error status', () => {
    expect(() => parseAttestationResponse({ messages: [{ status: 'error' }], error: 'bad' }, fail)).toThrow('bad');
  });

  it('bridge() keeps recovery data when attestation fails after the burn', async () => {
    const wc = { account: { address: '0x' + '11'.repeat(20) } } as never;
    const m = new BridgeModule(wc, 'base') as unknown as Record<string, unknown>;
    const burn = { burnTxHash: TX, nonce: 1n, messageHash: '0x01', messageBytes: '0x02', sourceDomain: 6, destinationDomain: 3 };
    m.approveUsdc = vi.fn().mockResolvedValue(undefined);
    m.depositForBurn = vi.fn().mockResolvedValue(burn);
    m.sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);
    const err = await (m as unknown as BridgeModule).bridge(1n, 'arbitrum').catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.recovery).toMatchObject({ burnTxHash: TX, sourceDomain: 6, toChain: 'arbitrum' });
    expect(fetchMock.mock.calls[0][0]).toContain('?transactionHash=');
  });
});

describe('parseAttestationResponse multi-message + eventNonce (#93 review)', () => {
  const hdr = (dest: string, nonce: string) =>
    ('0x' + '00000001' + '00000006' + dest + nonce + 'aa'.repeat(96) + '00000000' + '000003e8' + 'bb'.repeat(8)) as `0x${string}`;
  const src1 = hdr('00000005', '00'.repeat(32));
  const src2 = hdr('00000003', '00'.repeat(32));
  const att1 = hdr('00000005', '11'.repeat(32));
  const att2 = hdr('00000003', '22'.repeat(32));
  const fail = (m: string): never => { throw new Error(m); };
  const body = { messages: [
    { status: 'complete', message: att2, attestation: '0xb2', eventNonce: '0x' + '22'.repeat(32) },
    { status: 'complete', message: att1, attestation: '0xb1', eventNonce: '0x' + '11'.repeat(32) },
  ] };
  it('selects the entry matching the source message', () => {
    const r = parseAttestationResponse(body, fail, src1);
    expect(r).not.toBe('pending');
    if (r !== 'pending') { expect(r.message).toBe(att1); expect(r.attestation).toBe('0xb1'); expect(r.eventNonce).toBe('0x' + '11'.repeat(32)); }
    const r2 = parseAttestationResponse(body, fail, src2);
    if (r2 !== 'pending') expect(r2.attestation).toBe('0xb2');
  });
  it('refuses to guess without the source message', () => {
    expect(() => parseAttestationResponse(body, fail)).toThrow(/required/);
  });
  it('normalizes a decimal eventNonce to 32-byte hex', () => {
    const r = parseAttestationResponse({ messages: [{ status: 'complete', message: att1, attestation: '0xb1', eventNonce: '255' }] }, fail);
    if (r !== 'pending') expect(r.eventNonce).toBe('0x' + 'ff'.padStart(64, '0'));
  });
});

describe('batched burns sharing header fields (#93 review 2)', () => {
  const fail = (m: string): never => { throw new Error(m); };
  const header = (nonce: string) => '00000001' + '00000005' + '00000003' + nonce + 'aa'.repeat(96) + '000003e8' + '00000000';
  const body = (amount: string, filled: string) =>
    '00000001' + 'cc'.repeat(32) + 'dd'.repeat(32) + amount.padStart(64, '0') + 'ee'.repeat(32) + '00'.repeat(32) + filled.repeat(64) ;
  const msg = (nonce: string, amount: string, filled: string) => ('0x' + header(nonce) + body(amount, filled)) as `0x${string}`;
  const z = '00'.repeat(32);
  const res = { messages: [
    { status: 'complete', message: msg('11'.repeat(32), '64', '1'), attestation: '0xa1' },
    { status: 'complete', message: msg('22'.repeat(32), 'c8', '2'), attestation: '0xa2' },
  ] };
  it('selects by body (amount) when headers are identical', () => {
    const r = parseAttestationResponse(res, fail, msg(z, 'c8', '0'));
    expect(r !== 'pending' && r.attestation).toBe('0xa2');
    const r1 = parseAttestationResponse(res, fail, msg(z, '64', '0'));
    expect(r1 !== 'pending' && r1.attestation).toBe('0xa1');
  });
});

describe('single-message responses are matched too (#93 review 3)', () => {
  const fail = (m: string): never => { throw new Error(m); };
  const mk = (amt: string) => ('0x' + '00000001000000050000000' + '3' + '00'.repeat(32) + 'aa'.repeat(96) + '000003e8' + '00000000' + '00000001' + 'cc'.repeat(64) + amt.padStart(64, '0')) as `0x${string}`;
  it('rejects a one-message response for a different burn', () => {
    expect(() => parseAttestationResponse({ messages: [{ status: 'complete', message: mk('01'), attestation: '0xa1' }] }, fail, mk('02'))).toThrow(/no CCTP message matching/);
  });
  it('accepts the matching one-message response', () => {
    const r = parseAttestationResponse({ messages: [{ status: 'complete', message: mk('02'), attestation: '0xa1' }] }, fail, mk('02'));
    expect(r !== 'pending' && r.attestation).toBe('0xa1');
  });
  it('stays pending while the message is not yet available', () => {
    expect(parseAttestationResponse({ messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING' }] }, fail, mk('02'))).toBe('pending');
  });
});

describe('terminal errors with expectedMessage (#93 review 4)', () => {
  it('throws Circle error instead of pending', () => {
    const fail = (m: string): never => { throw new Error(m); };
    expect(() => parseAttestationResponse({ messages: [{ status: 'error' }], error: 'boom' }, fail, ('0x' + '11'.repeat(200)) as `0x${string}`)).toThrow(/boom/);
  });
});

describe('malformed source + identical batched burns (#93 review 5)', () => {
  const fail = (m: string): never => { throw new Error(m); };
  const msg = (nonce: string) => ('0x' + '000000010000000500000003' + nonce + 'aa'.repeat(96) + '000003e8' + '00000000' + 'bb'.repeat(170)) as `0x${string}`;
  const z = '00'.repeat(32);
  const res = { messages: [
    { status: 'complete', message: msg('11'.repeat(32)), attestation: '0xa1', eventNonce: '0x' + '11'.repeat(32) },
    { status: 'complete', message: msg('22'.repeat(32)), attestation: '0xa2', eventNonce: '0x' + '22'.repeat(32) },
  ] };
  it('rejects a truncated source message', () => {
    expect(() => parseAttestationResponse({ messages: [res.messages[0]] }, fail, '0x1234')).toThrow(/not a valid/);
  });
  it('requires a discriminator for identical burns', () => {
    expect(() => parseAttestationResponse(res, fail, msg(z))).toThrow(/eventNonce or messageIndex/);
  });
  it('selects by eventNonce or index', () => {
    const a = parseAttestationResponse(res, fail, msg(z), { eventNonce: '0x' + '22'.repeat(32) });
    expect(a !== 'pending' && a.attestation).toBe('0xa2');
    const b = parseAttestationResponse(res, fail, msg(z), { index: 0 });
    expect(b !== 'pending' && b.attestation).toBe('0xa1');
  });
});
