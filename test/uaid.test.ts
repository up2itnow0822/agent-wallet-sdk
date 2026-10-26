/**
 * uaid.test.ts — UAIDResolver unit tests
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { UAIDResolver } from '../src/identity/uaid.js';
import type { AgentIdentity } from '../src/identity/erc8004.js';

describe('UAIDResolver', () => {
  // ── Static parsing tests (no network) ──────────────────────────────────

  describe('parseUAID', () => {
    it('parses a valid ERC-8004 UAID', () => {
      const uaid = 'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004';
      const parsed = UAIDResolver.parseUAID(uaid);
      expect(parsed).not.toBeNull();
      expect(parsed!.aid).toBe('eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
      expect(parsed!.uid).toBe('42');
      expect(parsed!.protocol).toBe('erc8004');
      expect(parsed!.nativeId).toBeUndefined();
    });

    it('parses UAID with nativeId', () => {
      const uaid = 'uaid:aid:hedera:0.0.1234;uid=abc;proto=openconvai;nativeId=agent.hol.org';
      const parsed = UAIDResolver.parseUAID(uaid);
      expect(parsed).not.toBeNull();
      expect(parsed!.protocol).toBe('openconvai');
      expect(parsed!.nativeId).toBe('agent.hol.org');
    });

    it('returns null for invalid UAID', () => {
      expect(UAIDResolver.parseUAID('not-a-uaid')).toBeNull();
      expect(UAIDResolver.parseUAID('')).toBeNull();
      expect(UAIDResolver.parseUAID('uaid:')).toBeNull();
    });

    it('returns null when missing required parts', () => {
      expect(UAIDResolver.parseUAID('uaid:aid:foo')).toBeNull(); // missing uid and proto
      expect(UAIDResolver.parseUAID('uaid:aid:foo;uid=1')).toBeNull(); // missing proto
    });
  });

  // ── ERC-8004 ↔ Universal conversion ────────────────────────────────────

  describe('erc8004ToUniversal', () => {
    it('converts an ERC-8004 identity to universal format', () => {
      const resolver = new UAIDResolver();
      const identity: AgentIdentity = {
        agentId: 42n,
        owner: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        agentURI: 'data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBzL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSJ9',
        agentWallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
        registrationFile: null,
        modelMetadata: null,
      };

      const universal = resolver.erc8004ToUniversal(identity, 'base');
      expect(universal.agentId).toBe('42');
      expect(universal.owner).toBe('0x1234567890123456789012345678901234567890');
      expect(universal.paymentAddress).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
      expect(universal.protocol).toBe('erc8004');
      expect(universal.chain).toBe('eip155:8453');
      expect(universal.uaid).toContain('uaid:aid:eip155:8453');
      expect(universal.uaid).toContain('uid=42');
      expect(universal.uaid).toContain('proto=erc8004');
    });
  });

  describe('buildERC8004UAID', () => {
    it('builds a valid UAID string', () => {
      const resolver = new UAIDResolver();
      const uaid = resolver.buildERC8004UAID(
        42n,
        'base',
        '0x1234567890123456789012345678901234567890' as `0x${string}`,
      );
      expect(uaid).toBe('uaid:aid:eip155:8453:0x1234567890123456789012345678901234567890;uid=42;proto=erc8004');

      // Verify it parses back correctly
      const parsed = UAIDResolver.parseUAID(uaid);
      expect(parsed).not.toBeNull();
      expect(parsed!.uid).toBe('42');
      expect(parsed!.protocol).toBe('erc8004');
    });

    it('uses correct chain IDs for different chains', () => {
      const resolver = new UAIDResolver();
      const addr = '0x0000000000000000000000000000000000000001' as `0x${string}`;

      expect(resolver.buildERC8004UAID(1n, 'ethereum', addr)).toContain('eip155:1');
      expect(resolver.buildERC8004UAID(1n, 'base', addr)).toContain('eip155:8453');
      expect(resolver.buildERC8004UAID(1n, 'arbitrum', addr)).toContain('eip155:42161');
      expect(resolver.buildERC8004UAID(1n, 'polygon', addr)).toContain('eip155:137');
      expect(resolver.buildERC8004UAID(1n, 'base-sepolia', addr)).toContain('eip155:84532');
    });
  });

  // ── Cache behavior ─────────────────────────────────────────────────────

  describe('cache', () => {
    it('clearCache empties the cache', () => {
      const resolver = new UAIDResolver();
      // Just verify it doesn't throw
      resolver.clearCache();
    });
  });

  // ── Constructor defaults ───────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts empty config', () => {
      const resolver = new UAIDResolver();
      expect(resolver).toBeInstanceOf(UAIDResolver);
    });

    it('accepts custom config', () => {
      const resolver = new UAIDResolver({
        apiKey: 'test-key',
        brokerUrl: 'https://custom.broker.example',
        timeoutMs: 5000,
        cacheTtlMs: 60000,
      });
      expect(resolver).toBeInstanceOf(UAIDResolver);
    });
  });
});

// ─── Security regressions (findings 6, 18, 29) ─────────────────────────────

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const GOOD_UAID = `uaid:aid:eip155:8453:${REGISTRY};uid=42;proto=erc8004`;
const OWNER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x9999999999999999999999999999999999999999';

function brokerReturning(body: unknown, status = 200) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('UAIDResolver.verify — independent verification (finding 6)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const lookup = vi.fn(async () => ({ owner: OWNER as `0x${string}`, agentWallet: WALLET as `0x${string}`, blockNumber: 123n }));

  it('does not treat a broker "verified: true" claim as verification for non-ERC-8004 protocols', async () => {
    const uaid = 'uaid:aid:hedera:0.0.1234;uid=abc;proto=openconvai';
    vi.stubGlobal('fetch', brokerReturning({ uaid, protocol: 'openconvai', verified: true, paymentAddress: ATTACKER }));
    const v = await new UAIDResolver().verify(uaid);
    expect(v.verified).toBe(false);
    expect(v.brokerAttested).toBe(true);
    expect(v.identity).toBeNull();
  });

  it('rejects a broker-supplied payment address that differs from the on-chain agent wallet', async () => {
    vi.stubGlobal('fetch', brokerReturning({ uaid: GOOD_UAID, protocol: 'erc8004', agentId: '42', owner: OWNER, paymentAddress: ATTACKER, verified: true }));
    const v = await new UAIDResolver({ onChainLookup: lookup }).verify(GOOD_UAID);
    expect(v.verified).toBe(false);
    expect(v.error).toMatch(/payment address/);
  });

  it('verifies against the chain and returns on-chain owner and wallet', async () => {
    vi.stubGlobal('fetch', brokerReturning({ uaid: GOOD_UAID, protocol: 'erc8004', agentId: '42', verified: false }));
    const v = await new UAIDResolver({ onChainLookup: lookup }).verify(GOOD_UAID);
    expect(v.verified).toBe(true);
    expect(v.identity?.paymentAddress).toBe(WALLET);
    expect(v.identity?.owner).toBe(OWNER);
    expect(v.blockNumber).toBe(123n);
    expect(lookup).toHaveBeenCalledWith({ chain: 'base', registry: REGISTRY, agentId: 42n });
  });

  it('refuses an untrusted registry address in the UAID', async () => {
    const evil = `uaid:aid:eip155:8453:${ATTACKER};uid=42;proto=erc8004`;
    vi.stubGlobal('fetch', brokerReturning({ uaid: evil, protocol: 'erc8004', verified: true }));
    const v = await new UAIDResolver({ onChainLookup: lookup }).verify(evil);
    expect(v.verified).toBe(false);
    expect(v.error).toMatch(/not a trusted/);
  });

  it('rejects a broker record for a different UAID, protocol or agent id', async () => {
    const r = new UAIDResolver();
    vi.stubGlobal('fetch', brokerReturning({ uaid: GOOD_UAID.replace('uid=42', 'uid=43'), protocol: 'erc8004' }));
    expect((await r.resolve(GOOD_UAID)).resolved).toBe(false);
    vi.stubGlobal('fetch', brokerReturning({ protocol: 'a2a' }));
    expect((await new UAIDResolver().resolve(GOOD_UAID)).resolved).toBe(false);
    vi.stubGlobal('fetch', brokerReturning({ agentId: 7, protocol: 'erc8004' }));
    expect((await new UAIDResolver().resolve(GOOD_UAID)).resolved).toBe(false);
  });

  it('rejects untyped broker fields', async () => {
    vi.stubGlobal('fetch', brokerReturning({ protocol: 'erc8004', owner: { toString: () => OWNER }, verified: 'yes' }));
    expect((await new UAIDResolver().resolve(GOOD_UAID)).resolved).toBe(false);
  });
});

describe('UAIDResolver bounded broker I/O (finding 18)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies the timeout to the body, not just the headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }))));
    const started = Date.now();
    const r = await new UAIDResolver({ timeoutMs: 30 }).resolve(GOOD_UAID);
    expect(r.resolved).toBe(false);
    expect(r.error).toMatch(/exceeded|aborted/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps the response size', async () => {
    vi.stubGlobal('fetch', brokerReturning({ protocol: 'erc8004', agentURI: 'x'.repeat(10_000) }));
    const r = await new UAIDResolver({ maxResponseBytes: 1_024 }).resolve(GOOD_UAID);
    expect(r.resolved).toBe(false);
    expect(r.error).toMatch(/exceeded|declares/);
  });

  it('truncates error bodies from registration failures', async () => {
    vi.stubGlobal('fetch', brokerReturning('E'.repeat(50_000), 500));
    const err = await new UAIDResolver({ apiKey: 'k' })
      .registerERC8004Agent({ agentId: 1n, chain: 'base', name: 'n', description: 'd' }).catch((e) => e);
    expect(err.message.length).toBeLessThan(600);
  });
});

describe('UAIDResolver cache bounds (finding 29)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('evicts beyond cacheMaxEntries and drops expired entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const uaid = decodeURIComponent(String(url).split('uaid=')[1]);
      return new Response(JSON.stringify({ uaid, protocol: 'erc8004' }));
    }));
    const r = new UAIDResolver({ cacheMaxEntries: 5, cacheTtlMs: 50 });
    for (let i = 0; i < 50; i++) {
      await r.resolve(`uaid:aid:eip155:8453:${REGISTRY};uid=${i};proto=erc8004`);
    }
    expect(r.cacheSize).toBe(5);
    await new Promise((res) => setTimeout(res, 60));
    await r.resolve(`uaid:aid:eip155:8453:${REGISTRY};uid=999;proto=erc8004`);
    expect(r.cacheSize).toBe(1);
  });

  it('does not cache or query malformed / oversized keys', async () => {
    const f = brokerReturning({});
    vi.stubGlobal('fetch', f);
    const r = new UAIDResolver();
    expect((await r.resolve('x'.repeat(10_000))).resolved).toBe(false);
    expect((await r.resolve('not-a-uaid')).resolved).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(r.cacheSize).toBe(0);
  });
});
