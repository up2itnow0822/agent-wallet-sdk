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
