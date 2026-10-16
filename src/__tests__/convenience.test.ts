import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import {
  resolveEnvSpendLimits,
  resolveWalletChain,
  setPolicyFromEnv,
  walletFromEnv,
  x402FromEnv,
} from '../convenience.js';
import { USDC_ADDRESSES, X402_PROTOCOL_FEE_COLLECTOR } from '../x402/index.js';
import type { X402PaymentRequirements } from '../x402/types.js';

const TEST_PRIVATE_KEY = `0x${'01'.repeat(32)}`;

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

  it('maps Eliza-supported L2s onto createWallet keys', () => {
    expect(resolveWalletChain('optimism').walletChain).toBe('optimism');
    expect(resolveWalletChain(10).walletChain).toBe('optimism');
    expect(resolveWalletChain('avalanche').walletChain).toBe('avalanche');
    expect(resolveWalletChain('unichain').walletChain).toBe('unichain');
    expect(resolveWalletChain('linea').walletChain).toBe('linea');
    expect(resolveWalletChain('sonic').walletChain).toBe('sonic');
    expect(resolveWalletChain('worldchain').walletChain).toBe('worldchain');
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
    process.env.AGENT_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.AGENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000001';
    process.env.CHAIN_NAME = 'arbitrum';
    delete process.env.CHAIN_ID;
    delete process.env.RPC_URL;

    const wallet = walletFromEnv();

    expect(wallet.chain.id).toBe(42161);
    expect(wallet.chain.name).toBe('Arbitrum One');
  });

  it('bootstraps Base Sepolia from CHAIN_ID', () => {
    process.env.AGENT_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.AGENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000001';
    delete process.env.CHAIN_NAME;
    process.env.CHAIN_ID = '84532';
    delete process.env.RPC_URL;

    const wallet = walletFromEnv();

    expect(wallet.chain.id).toBe(84532);
  });
});

describe('USDC environment spending controls', () => {
  const recipient = getAddress('0xabcdef0000000000000000000000000000000001');
  const otherRecipient = '0x1111111111111111111111111111111111111111';
  const url = 'https://api.example.com/data';
  const previous = {
    SPEND_LIMIT_PER_TX: process.env.SPEND_LIMIT_PER_TX,
    SPEND_LIMIT_DAILY: process.env.SPEND_LIMIT_DAILY,
    SPEND_ALLOWLIST: process.env.SPEND_ALLOWLIST,
    X402_SUPPORTED_NETWORKS: process.env.X402_SUPPORTED_NETWORKS,
    X402_GLOBAL_DAILY_LIMIT: process.env.X402_GLOBAL_DAILY_LIMIT,
    X402_PER_REQUEST_MAX: process.env.X402_PER_REQUEST_MAX,
  };

  beforeEach(() => {
    for (const name of Object.keys(previous)) delete process.env[name];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function mockWallet(chainId = 8453) {
    const transfer = vi.fn(async (_args: unknown[], _options: unknown) => `0x${'ab'.repeat(32)}`);
    const setPolicy = vi.fn(async (_args: unknown[], _options: unknown) => `0x${'cd'.repeat(32)}`);
    const wallet = {
      address: otherRecipient,
      chain: { id: chainId, name: 'Test chain' },
      walletClient: { account: { address: otherRecipient } },
      contract: {
        read: { remainingBudget: vi.fn(async () => [10n ** 18n, 10n ** 18n]) },
        write: { agentTransferToken: transfer, setSpendPolicy: setPolicy },
      },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) },
    } as unknown as Parameters<typeof x402FromEnv>[0];
    return { wallet, transfer, setPolicy };
  }

  function option(overrides: Partial<X402PaymentRequirements> = {}): X402PaymentRequirements {
    return {
      scheme: 'exact', network: 'base:8453', asset: USDC_ADDRESSES['base:8453'],
      amount: '900000', payTo: recipient, maxTimeoutSeconds: 30, extra: {},
      ...overrides,
    };
  }

  function respondWithPayment(requirement: X402PaymentRequirements) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) return new Response('paid', { status: 200 });
      return new Response(null, {
        status: 402,
        headers: {
          'payment-required': btoa(JSON.stringify({
            x402Version: 1,
            resource: { url: '/data', description: 'Test data', mimeType: 'application/json' },
            accepts: [requirement],
          })),
        },
      });
    });
  }

  const capNames = [
    'SPEND_LIMIT_PER_TX', 'SPEND_LIMIT_DAILY',
    'X402_GLOBAL_DAILY_LIMIT', 'X402_PER_REQUEST_MAX',
  ] as const;

  it.each(capNames.flatMap((name) => (
    ['not-a-number', '-0.01', '1.1234567', '1.0000000'].map((value) => [name, value] as const)
  )))('rejects invalid %s=%s instead of omitting or rounding a configured cap', async (name, value) => {
    for (const capName of capNames) process.env[capName] = '1';
    process.env[name] = value;
    const { wallet, setPolicy, transfer } = mockWallet();

    if (name.startsWith('SPEND_')) {
      await expect(setPolicyFromEnv(wallet)).rejects.toThrow(new RegExp(name));
      expect(setPolicy).not.toHaveBeenCalled();
    } else {
      expect(() => x402FromEnv(wallet)).toThrow(new RegExp(name));
    }
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each(['NaN', 'Infinity', '1e3', '0x10', '+1', '1.', '.5', '1,000', '-0'])('rejects non-decimal cap syntax %s', (value) => {
    process.env.X402_PER_REQUEST_MAX = value;
    const { wallet } = mockWallet();
    expect(() => x402FromEnv(wallet)).toThrow(/X402_PER_REQUEST_MAX/);
  });

  it.each(capNames.flatMap((name) => [undefined, '', ' \t\n '].map((value) => [name, value] as const)))('keeps optional %s=%j as omitted', async (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    const { wallet, setPolicy } = mockWallet();
    if (name.startsWith('SPEND_')) {
      const otherName = name === 'SPEND_LIMIT_PER_TX' ? 'SPEND_LIMIT_DAILY' : 'SPEND_LIMIT_PER_TX';
      process.env[otherName] = '2';
      await setPolicyFromEnv(wallet);
      expect(setPolicy.mock.calls[0][0]).toEqual([
        USDC_ADDRESSES['base:8453'], 2_000_000n, 2_000_000n, 86400n,
      ]);
    } else {
      expect(x402FromEnv(wallet).budgetTracker.checkBudget('api.example.com', 2_000_000n).allowed).toBe(true);
    }
  });

  it.each(capNames)('preserves an explicit zero cap in %s', async (name) => {
    process.env[name] = '0';
    const { wallet, setPolicy, transfer } = mockWallet();
    if (name.startsWith('SPEND_')) {
      const otherName = name === 'SPEND_LIMIT_PER_TX' ? 'SPEND_LIMIT_DAILY' : 'SPEND_LIMIT_PER_TX';
      process.env[otherName] = '2';
      await setPolicyFromEnv(wallet);
      expect(setPolicy.mock.calls[0][0]).toEqual([
        USDC_ADDRESSES['base:8453'],
        name === 'SPEND_LIMIT_PER_TX' ? 0n : 2_000_000n,
        name === 'SPEND_LIMIT_DAILY' ? 0n : 2_000_000n,
        86400n,
      ]);
    } else {
      respondWithPayment(option());
      await expect(x402FromEnv(wallet).fetch(url)).rejects.toThrow(/global (daily limit|per-request max)/);
      expect(transfer).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['0.000001', 1n], ['1.234567', 1_234_567n], ['0001.000002', 1_000_002n],
    [' 1.234567 ', 1_234_567n], ['9007199254740993.123456', 9_007_199_254_740_993_123_456n],
  ] as const)('parses %s into exact USDC units in policy and client limits', async (value, raw) => {
    process.env.SPEND_LIMIT_PER_TX = value;
    process.env.X402_GLOBAL_DAILY_LIMIT = value;
    const { wallet, setPolicy } = mockWallet();
    await setPolicyFromEnv(wallet);
    expect(setPolicy.mock.calls[0][0]).toEqual([
      USDC_ADDRESSES['base:8453'], raw, raw, 86400n,
    ]);
    const client = x402FromEnv(wallet);
    expect(client.budgetTracker.checkBudget('api.example.com', raw).allowed).toBe(true);
    expect(client.budgetTracker.checkBudget('api.example.com', raw + 1n).allowed).toBe(false);
  });

  it('keeps all-blank spending settings in queue-for-approval mode', async () => {
    process.env.SPEND_LIMIT_PER_TX = '';
    process.env.SPEND_LIMIT_DAILY = ' \t ';
    const { wallet, setPolicy } = mockWallet();
    await setPolicyFromEnv(wallet);
    expect(setPolicy.mock.calls[0][0]).toEqual([
      USDC_ADDRESSES['base:8453'], 0n, 0n, 86400n,
    ]);
  });

  it.each([
    '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', 'WBTC',
    '0x4200000000000000000000000000000000000006', 'WETH',
  ])('does not treat raw %s amounts as USDC under a 1 USDC ceiling', async (asset) => {
    process.env.X402_PER_REQUEST_MAX = '1';
    process.env.X402_GLOBAL_DAILY_LIMIT = '1';
    const { wallet, transfer } = mockWallet();
    respondWithPayment(option({ asset }));
    const client = x402FromEnv(wallet);

    expect((await client.fetch(url)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
    expect(client.getDailySpendSummary().global).toBe(0n);
  });

  it('accepts only the configured chain USDC address even when multiple networks are configured', () => {
    process.env.X402_SUPPORTED_NETWORKS = 'base:8453,arbitrum:42161';
    const { wallet } = mockWallet();
    const client = x402FromEnv(wallet);
    expect(client.selectPaymentOption([option()])).not.toBeNull();
    expect(client.selectPaymentOption([option({ asset: 'USDC' })])).toBeNull();
    expect(client.selectPaymentOption([option({
      network: 'arbitrum:42161', asset: USDC_ADDRESSES['arbitrum:42161'],
    })])).toBeNull();
  });

  it('uses testnet USDC only when that testnet network is explicitly configured', () => {
    process.env.X402_SUPPORTED_NETWORKS = 'base-sepolia:84532';
    const { wallet } = mockWallet(84532);
    const client = x402FromEnv(wallet);
    expect(client.selectPaymentOption([option({
      network: 'base-sepolia:84532', asset: USDC_ADDRESSES['base-sepolia:84532'],
    })])).not.toBeNull();
    expect(client.selectPaymentOption([option({
      network: 'base-sepolia:84532', asset: USDC_ADDRESSES['base:8453'],
    })])).toBeNull();
  });

  it('rejects a wallet without a known USDC deployment', async () => {
    const { wallet, setPolicy } = mockWallet(99999);
    process.env.SPEND_LIMIT_PER_TX = '1';
    expect(() => x402FromEnv(wallet)).toThrow(/USDC.*chain/i);
    await expect(setPolicyFromEnv(wallet)).rejects.toThrow(/USDC.*chain/i);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('rejects a disallowed merchant before either the fixed protocol fee or payee transfer', async () => {
    process.env.SPEND_ALLOWLIST = recipient;
    const { wallet, transfer } = mockWallet();
    respondWithPayment(option({ payTo: otherRecipient }));
    const client = x402FromEnv(wallet);

    expect((await client.fetch(url)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('matches allowed recipients case-insensitively and permits the fixed fee collector separately', async () => {
    process.env.SPEND_ALLOWLIST = ` ${recipient.toLowerCase()} , ${otherRecipient} `;
    const { wallet, transfer } = mockWallet();
    respondWithPayment(option());
    const client = x402FromEnv(wallet);

    expect((await client.fetch(url)).status).toBe(200);
    expect(transfer.mock.calls.map(([args]) => args)).toEqual([
      [USDC_ADDRESSES['base:8453'], X402_PROTOCOL_FEE_COLLECTOR, 6930n],
      [USDC_ADDRESSES['base:8453'], recipient, 900000n],
    ]);
    expect(client.getDailySpendSummary().global).toBe(906930n);
  });

  it.each(['not-an-address', '0x1234', `${recipient},`, ','])('rejects malformed recipient allowlist %s before a policy write or client creation', async (allowlist) => {
    process.env.SPEND_ALLOWLIST = allowlist;
    process.env.SPEND_LIMIT_PER_TX = '1';
    const { wallet, setPolicy } = mockWallet();
    expect(() => x402FromEnv(wallet)).toThrow(/SPEND_ALLOWLIST/);
    await expect(setPolicyFromEnv(wallet)).rejects.toThrow(/SPEND_ALLOWLIST/);
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('treats an empty recipient setting as omitted', async () => {
    process.env.SPEND_ALLOWLIST = '  ';
    const { wallet, transfer } = mockWallet();
    respondWithPayment(option({ payTo: otherRecipient }));
    expect((await x402FromEnv(wallet).fetch(url)).status).toBe(200);
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it('sets the USDC policy without presenting recipients as on-chain token restrictions', async () => {
    process.env.SPEND_ALLOWLIST = recipient;
    process.env.SPEND_LIMIT_PER_TX = '1';
    const { wallet, setPolicy } = mockWallet();
    await setPolicyFromEnv(wallet);
    expect(setPolicy.mock.calls[0][0]).toEqual([
      USDC_ADDRESSES['base:8453'], 1_000_000n, 1_000_000n, 86400n,
    ]);
  });
});
