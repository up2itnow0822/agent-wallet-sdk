/**
 * uaid.test.ts — UAIDResolver unit tests
 */
import { describe, it, expect } from 'vitest';
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
