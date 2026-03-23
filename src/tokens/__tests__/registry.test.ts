/**
 * Tests for the TokenRegistry — pre-populated multi-chain token registry.
 */
import { describe, it, expect } from 'vitest';
import { TokenRegistry, getGlobalRegistry, BASE_REGISTRY, ETHEREUM_REGISTRY } from '../registry.js';
import { zeroAddress } from 'viem';

// Chain IDs
const ETH    = 1;
const BASE   = 8453;
const ARB    = 42161;
const OP     = 10;
const POLY   = 137;
const AVAX   = 43114;
const SONIC  = 146;

describe('TokenRegistry — construction', () => {
  it('creates a registry and has tokens pre-populated', () => {
    const r = new TokenRegistry();
    expect(r.size()).toBeGreaterThan(0);
  });

  it('populates tokens for Ethereum mainnet', () => {
    const r = new TokenRegistry();
    const tokens = r.listTokens(ETH);
    expect(tokens.length).toBeGreaterThanOrEqual(10);
    const symbols = tokens.map(t => t.symbol);
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('WETH');
    expect(symbols).toContain('WBTC');
    expect(symbols).toContain('LINK');
    expect(symbols).toContain('UNI');
    expect(symbols).toContain('AAVE');
    expect(symbols).toContain('DAI');
    expect(symbols).toContain('MKR');
    expect(symbols).toContain('ETH');  // native
  });

  it('populates tokens for Base mainnet', () => {
    const r = new TokenRegistry();
    const tokens = r.listTokens(BASE);
    const symbols = tokens.map(t => t.symbol);
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('WETH');
    expect(symbols).toContain('cbETH');
  });

  it('populates ARB on Arbitrum', () => {
    const r = new TokenRegistry();
    const token = r.getToken('ARB', ARB);
    expect(token).toBeDefined();
    expect(token!.address.toLowerCase()).toBe('0x912ce59144191c1204e64559fe8253a0e49e6548');
  });

  it('populates OP on Optimism', () => {
    const r = new TokenRegistry();
    const token = r.getToken('OP', OP);
    expect(token).toBeDefined();
    expect(token!.address.toLowerCase()).toBe('0x4200000000000000000000000000000000000042');
  });

  it('populates WMATIC on Polygon', () => {
    const r = new TokenRegistry();
    const token = r.getToken('WMATIC', POLY);
    expect(token).toBeDefined();
    expect(token!.address.toLowerCase()).toBe('0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270');
  });

  it('populates WAVAX on Avalanche', () => {
    const r = new TokenRegistry();
    const token = r.getToken('WAVAX', AVAX);
    expect(token).toBeDefined();
    expect(token!.address.toLowerCase()).toBe('0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7');
  });

  it('includes native gas tokens with isNative=true and zeroAddress', () => {
    const r = new TokenRegistry();
    const eth = r.getToken('ETH', BASE);
    expect(eth).toBeDefined();
    expect(eth!.isNative).toBe(true);
    expect(eth!.address).toBe(zeroAddress);

    const pol = r.getToken('POL', POLY);
    expect(pol).toBeDefined();
    expect(pol!.isNative).toBe(true);

    const avax = r.getToken('AVAX', AVAX);
    expect(avax).toBeDefined();
    expect(avax!.isNative).toBe(true);

    const s = r.getToken('S', SONIC);
    expect(s).toBeDefined();
    expect(s!.isNative).toBe(true);
  });
});

describe('TokenRegistry — getToken', () => {
  it('returns undefined for unknown symbol', () => {
    const r = new TokenRegistry();
    expect(r.getToken('FAKECOIN', ETH)).toBeUndefined();
  });

  it('is case-insensitive for symbol lookup', () => {
    const r = new TokenRegistry();
    expect(r.getToken('usdc', ETH)).toBeDefined();
    expect(r.getToken('USDC', ETH)).toBeDefined();
    expect(r.getToken('Usdc', ETH)).toBeDefined();
  });

  it('USDC on Ethereum is correct address', () => {
    const r = new TokenRegistry();
    const usdc = r.getToken('USDC', ETH);
    expect(usdc!.address.toLowerCase()).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(usdc!.decimals).toBe(6);
  });

  it('USDC on Base is correct address', () => {
    const r = new TokenRegistry();
    const usdc = r.getToken('USDC', BASE);
    expect(usdc!.address.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('WETH on Ethereum is correct address', () => {
    const r = new TokenRegistry();
    const weth = r.getToken('WETH', ETH);
    expect(weth!.address.toLowerCase()).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(weth!.decimals).toBe(18);
  });
});

describe('TokenRegistry — addToken (custom)', () => {
  it('adds a custom token and retrieves it', () => {
    const r = new TokenRegistry();
    r.addToken({
      symbol: 'MYTOKEN',
      address: '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef',
      decimals: 18,
      chainId: BASE,
      name: 'My Custom Token',
    });

    const t = r.getToken('MYTOKEN', BASE);
    expect(t).toBeDefined();
    expect(t!.name).toBe('My Custom Token');
    expect(t!.decimals).toBe(18);
  });

  it('overwriting a token with addToken replaces it', () => {
    const r = new TokenRegistry();
    r.addToken({
      symbol: 'USDC',
      address: '0x1234567890123456789012345678901234567890',
      decimals: 6,
      chainId: BASE,
      name: 'Test USDC',
    });

    const usdc = r.getToken('USDC', BASE);
    expect(usdc!.address.toLowerCase()).toBe('0x1234567890123456789012345678901234567890');
  });
});

describe('TokenRegistry — listTokens', () => {
  it('returns all tokens for a chain', () => {
    const r = new TokenRegistry();
    const tokens = r.listTokens(ARB);
    expect(tokens.length).toBeGreaterThan(0);
    // Every returned token should have chainId === ARB
    for (const t of tokens) {
      expect(t.chainId).toBe(ARB);
    }
  });

  it('returns empty array for unknown chainId', () => {
    const r = new TokenRegistry();
    const tokens = r.listTokens(99999);
    expect(tokens).toEqual([]);
  });
});

describe('TokenRegistry — getTokenByAddress', () => {
  it('finds a token by its address', () => {
    const r = new TokenRegistry();
    const usdc = r.getTokenByAddress(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      ETH,
    );
    expect(usdc).toBeDefined();
    expect(usdc!.symbol).toBe('USDC');
  });

  it('is case-insensitive for address lookup', () => {
    const r = new TokenRegistry();
    const usdc = r.getTokenByAddress(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // lower
      ETH,
    );
    expect(usdc).toBeDefined();
  });

  it('returns undefined for unknown address', () => {
    const r = new TokenRegistry();
    const t = r.getTokenByAddress('0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef', ETH);
    expect(t).toBeUndefined();
  });
});

describe('Pre-built registry exports', () => {
  it('BASE_REGISTRY has Base tokens', () => {
    const tokens = BASE_REGISTRY.listTokens(BASE);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('ETHEREUM_REGISTRY has Ethereum tokens', () => {
    const tokens = ETHEREUM_REGISTRY.listTokens(ETH);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('getGlobalRegistry() returns consistent instance', () => {
    const r1 = getGlobalRegistry();
    const r2 = getGlobalRegistry();
    expect(r1).toBe(r2);
  });
});
