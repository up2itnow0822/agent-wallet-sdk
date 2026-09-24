import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import {
  resolveEnvSpendLimits,
  resolveWalletChain,
  walletFromEnv,
} from '../convenience.js';

describe('resolveWalletChain', () => {
  it('maps documented CHAIN_NAME=arbitrum to the createWallet key, not "arbitrum one"', () => {
    const resolved = resolveWalletChain('arbitrum');
    expect(resolved.chain.id).toBe(42161);
    expect(resolved.walletChain).toBe('arbitrum');
    expect(resolved.rpcUrl).toBe('https://arb1.arbitrum.io/rpc');
  });

  it('maps base-sepolia by name and by chain id', () => {
    expect(resolveWalletChain('base-sepolia').walletChain).toBe('base-sepolia');
    expect(resolveWalletChain(84532).walletChain).toBe('base-sepolia');
    expect(resolveWalletChain('base-sepolia').rpcUrl).toBe('https://sepolia.base.org');
  });

  it('maps ethereum aliases to the createWallet key', () => {
    expect(resolveWalletChain('ethereum').walletChain).toBe('ethereum');
    expect(resolveWalletChain('mainnet').walletChain).toBe('ethereum');
    expect(resolveWalletChain(1).walletChain).toBe('ethereum');
  });

  it('keeps the documented unknown-id fallback on Base', () => {
    const resolved = resolveWalletChain(99999);
    expect(resolved.chain.id).toBe(8453);
    expect(resolved.walletChain).toBe('base');
  });
});

describe('resolveEnvSpendLimits', () => {
  it('queues for approval when neither limit is set', () => {
    expect(resolveEnvSpendLimits(undefined, undefined)).toEqual({
      perTxLimit: 0n,
      periodLimit: 0n,
      queueOnly: true,
    });
  });

  it('does not write the 0n disable-all sentinel when only per-tx is set', () => {
    expect(resolveEnvSpendLimits(1_000_000n, undefined)).toEqual({
      perTxLimit: 1_000_000n,
      periodLimit: 1_000_000n,
      queueOnly: false,
    });
  });

  it('does not write the 0n disable-all sentinel when only daily is set', () => {
    expect(resolveEnvSpendLimits(undefined, 10_000_000n)).toEqual({
      perTxLimit: 10_000_000n,
      periodLimit: 10_000_000n,
      queueOnly: false,
    });
  });

  it('keeps independently configured limits', () => {
    expect(resolveEnvSpendLimits(1_000_000n, 10_000_000n)).toEqual({
      perTxLimit: 1_000_000n,
      periodLimit: 10_000_000n,
      queueOnly: false,
    });
  });
});

describe('walletFromEnv', () => {
  const previous = {
    AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
    AGENT_WALLET_ADDRESS: process.env.AGENT_WALLET_ADDRESS,
    CHAIN_NAME: process.env.CHAIN_NAME,
    CHAIN_ID: process.env.CHAIN_ID,
    RPC_URL: process.env.RPC_URL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('bootstraps an Arbitrum wallet from the documented CHAIN_NAME', () => {
    process.env.AGENT_PRIVATE_KEY = generatePrivateKey();
    process.env.AGENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.CHAIN_NAME = 'arbitrum';
    delete process.env.CHAIN_ID;
    delete process.env.RPC_URL;

    const wallet = walletFromEnv();

    expect(wallet.chain.id).toBe(42161);
    expect(wallet.chain.name).toBe('Arbitrum One');
  });

  it('bootstraps Base Sepolia from CHAIN_ID', () => {
    process.env.AGENT_PRIVATE_KEY = generatePrivateKey();
    process.env.AGENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000001';
    delete process.env.CHAIN_NAME;
    process.env.CHAIN_ID = '84532';
    delete process.env.RPC_URL;

    const wallet = walletFromEnv();

    expect(wallet.chain.id).toBe(84532);
  });
});
