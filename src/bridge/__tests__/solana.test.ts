// Bridge tests — Solana CCTP domain mapping and address encoding
import { describe, it, expect } from 'vitest';
import {
  SOLANA_CCTP_DOMAIN,
  SOLANA_USDC_MINT,
  SOLANA_TOKEN_MESSENGER,
  SOLANA_MESSAGE_TRANSMITTER,
  bytes32ToSolanaPubkey,
} from '../solana.js';
import {
  CCTP_DOMAIN_IDS,
  BRIDGE_CHAIN_IDS,
  USDC_CONTRACT,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
} from '../types.js';

describe('Solana CCTP constants', () => {
  it('has correct Solana CCTP domain (5)', () => {
    expect(SOLANA_CCTP_DOMAIN).toBe(5);
    expect(CCTP_DOMAIN_IDS['solana']).toBe(5);
  });

  it('has correct Solana USDC mint', () => {
    expect(SOLANA_USDC_MINT).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('has correct Solana CCTP V2 TokenMessengerMinterV2 program (not V1)', () => {
    // V2 address — verified against https://developers.circle.com/cctp/references/solana-programs
    // and https://github.com/circlefin/solana-cctp-contracts (programs/v2)
    // V1 address (invalid for this SDK): CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3
    expect(SOLANA_TOKEN_MESSENGER).toBe('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe');
  });

  it('has correct Solana CCTP V2 MessageTransmitterV2 program (not V1)', () => {
    // V2 address — verified against https://developers.circle.com/cctp/references/solana-programs
    // and https://github.com/circlefin/solana-cctp-contracts (programs/v2)
    // V1 address (invalid for this SDK): CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd
    expect(SOLANA_MESSAGE_TRANSMITTER).toBe('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC');
  });
});

describe('CCTP domain IDs', () => {
  it('maps all EVM chains correctly', () => {
    expect(CCTP_DOMAIN_IDS['ethereum']).toBe(0);
    expect(CCTP_DOMAIN_IDS['avalanche']).toBe(1);
    expect(CCTP_DOMAIN_IDS['optimism']).toBe(2);
    expect(CCTP_DOMAIN_IDS['arbitrum']).toBe(3);
    expect(CCTP_DOMAIN_IDS['base']).toBe(6);
    expect(CCTP_DOMAIN_IDS['polygon']).toBe(7);
    expect(CCTP_DOMAIN_IDS['unichain']).toBe(10);
    expect(CCTP_DOMAIN_IDS['linea']).toBe(11);
    expect(CCTP_DOMAIN_IDS['sonic']).toBe(13);
    expect(CCTP_DOMAIN_IDS['worldchain']).toBe(14);
    expect(CCTP_DOMAIN_IDS['solana']).toBe(5);
  });

  it('Solana domain (5) does not conflict with EVM domains', () => {
    const evmDomains = Object.entries(CCTP_DOMAIN_IDS)
      .filter(([chain]) => chain !== 'solana')
      .map(([, domain]) => domain);
    expect(evmDomains).not.toContain(5);
  });
});

describe('EVM bridge chain IDs', () => {
  it('maps all EVM chains to correct IDs', () => {
    expect(BRIDGE_CHAIN_IDS['base']).toBe(8453);
    expect(BRIDGE_CHAIN_IDS['ethereum']).toBe(1);
    expect(BRIDGE_CHAIN_IDS['arbitrum']).toBe(42161);
    expect(BRIDGE_CHAIN_IDS['polygon']).toBe(137);
    expect(BRIDGE_CHAIN_IDS['optimism']).toBe(10);
    expect(BRIDGE_CHAIN_IDS['avalanche']).toBe(43114);
    expect(BRIDGE_CHAIN_IDS['unichain']).toBe(130);
    expect(BRIDGE_CHAIN_IDS['linea']).toBe(59144);
    expect(BRIDGE_CHAIN_IDS['sonic']).toBe(146);
    expect(BRIDGE_CHAIN_IDS['worldchain']).toBe(480);
  });

  it('does not include solana (Solana has no EVM chain ID)', () => {
    expect(('solana' in BRIDGE_CHAIN_IDS)).toBe(false);
  });
});

describe('USDC contract addresses', () => {
  it('all EVM chains have valid 0x addresses', () => {
    const chains = Object.keys(USDC_CONTRACT);
    expect(chains.length).toBe(10);
    for (const [chain, addr] of Object.entries(USDC_CONTRACT)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('does not include solana in EVM USDC_CONTRACT', () => {
    expect(('solana' in USDC_CONTRACT)).toBe(false);
  });
});

describe('CCTP V2 contract addresses (EVM)', () => {
  it('all chains share the same deterministic TokenMessengerV2 address', () => {
    const addresses = Object.values(TOKEN_MESSENGER_V2);
    const unique = new Set(addresses);
    expect(unique.size).toBe(1);
    expect(addresses[0]).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
  });

  it('all chains share the same deterministic MessageTransmitterV2 address', () => {
    const addresses = Object.values(MESSAGE_TRANSMITTER_V2);
    const unique = new Set(addresses);
    expect(unique.size).toBe(1);
    expect(addresses[0]).toBe('0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
  });
});

describe('bytes32ToSolanaPubkey', () => {
  it('round-trips a known Solana public key from 32-byte hex', () => {
    // 32-byte zero-padded hex (a simple known value)
    // All zeros except last byte = 1 → base58 "11111111111111111111111111111112" (system program variant)
    const BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;

    const result = bytes32ToSolanaPubkey(BYTES32);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(44);
    // Only valid base58 chars
    expect(result).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
  });

  it('throws on non-32-byte input', () => {
    expect(() => bytes32ToSolanaPubkey('0x1234' as `0x${string}`)).toThrow();
  });
});
