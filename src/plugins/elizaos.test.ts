import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData } from 'viem';
import { AgentAccountV2Abi } from '../abi.js';
import AgentWalletPlugin, { createAgentFetch, getAgentWallet } from './elizaos.js';
import type { AgentWalletPluginConfig } from './elizaos.js';
import { USDC_ADDRESSES } from '../x402/types.js';
import { X402_PROTOCOL_FEE_COLLECTOR } from '../x402/fee.js';
import type { X402Fetch } from '../x402/middleware.js';

const { createWalletMock, transfer, receipt, transaction } = vi.hoisted(() => ({
  createWalletMock: vi.fn(), transfer: vi.fn(), receipt: vi.fn(), transaction: vi.fn(),
}));

vi.mock('../index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../index.js')>();
  return { ...original, createWallet: createWalletMock };
});

const KEY_A = `0x${'01'.repeat(32)}` as const;
const KEY_B = `0x${'02'.repeat(32)}` as const;
const ADDRESS_A = '0x1111111111111111111111111111111111111111';
const ADDRESS_B = '0x2222222222222222222222222222222222222222';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const url = 'https://api.example.com/data';

type TestRuntime = {
  getSetting: (name: string) => string | undefined;
  agentWallet?: ReturnType<typeof getAgentWallet>;
  x402Fetch?: X402Fetch;
};

const provider = AgentWalletPlugin.providers![0] as unknown as {
  get(runtime: TestRuntime): Promise<string>;
};

function config(overrides: Partial<AgentWalletPluginConfig> = {}): AgentWalletPluginConfig {
  return { privateKey: KEY_A, accountAddress: ADDRESS_A, x402DailyLimit: 1_000_000n, ...overrides };
}

function runtime(overrides: Record<string, string> = {}) {
  const settings: Record<string, string> = {
    AGENT_PRIVATE_KEY: KEY_A,
    AGENT_ACCOUNT_ADDRESS: ADDRESS_A,
    AGENT_CHAIN: 'base',
    X402_DAILY_LIMIT: '1000000',
    ...overrides,
  };
  const runtime: TestRuntime = { getSetting: (name) => settings[name] };
  return { runtime, settings };
}

function respondWithPayment(opts: { nonce?: string; asset?: string } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (new Headers(init?.headers).has('X-PAYMENT')) return new Response('paid', { status: 200 });
    return new Response(null, {
      status: 402,
      headers: {
        'payment-required': btoa(JSON.stringify({
          x402Version: 1,
          resource: { url: '/data', description: 'Test data', mimeType: 'application/json' },
          accepts: [{
            scheme: 'exact', network: 'base:8453', asset: opts.asset ?? USDC_ADDRESSES['base:8453'],
            amount: '600000', payTo: PAY_TO, maxTimeoutSeconds: 30,
            extra: { nonce: opts.nonce ?? 'first-intent' },
          }],
        })),
      },
    });
  });
}

beforeEach(() => {
  createWalletMock.mockReset().mockImplementation((config) => ({
    address: config.accountAddress,
    chain: { id: config.chain === 'arbitrum' ? 42161 : 8453 },
    walletClient: config.walletClient,
    contract: {
      read: { remainingBudget: async () => [10n ** 18n, 10n ** 18n] },
      write: { agentTransferToken: transfer },
    },
    publicClient: { waitForTransactionReceipt: receipt, getTransaction: transaction },
  }));
  transfer.mockReset().mockImplementation(async () => `0x${'ab'.repeat(32)}`);
  receipt.mockReset().mockResolvedValue({ status: 'success' });
  transaction.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('ElizaOS wallet configuration isolation', () => {
  it('keeps separate config objects and non-custodial signers in separate wallets', () => {
    const first = getAgentWallet(config());
    const second = getAgentWallet(config({ privateKey: KEY_B, accountAddress: ADDRESS_B, chain: 'arbitrum' }));

    expect(second).not.toBe(first);
    expect(first.address).toBe(ADDRESS_A);
    expect(second.address).toBe(ADDRESS_B);
    expect(first.walletClient.account!.address).toBe(privateKeyToAccount(KEY_A).address);
    expect(second.walletClient.account!.address).toBe(privateKeyToAccount(KEY_B).address);
    expect(second.chain.id).toBe(42161);
  });

  it('uses config object identity as the explicit cache scope and retains its fetch', () => {
    const firstConfig = config();
    const first = getAgentWallet(firstConfig);
    expect(getAgentWallet(firstConfig)).toBe(first);
    expect(getAgentWallet(config())).not.toBe(first);
    expect(createAgentFetch(firstConfig)).toBe(createAgentFetch(firstConfig));
  });

  it('applies a custom RPC URL to both wallet transports', () => {
    getAgentWallet(config({ rpcUrl: 'https://rpc.example.test' }));
    expect(createWalletMock).toHaveBeenCalledWith(expect.objectContaining({ rpcUrl: 'https://rpc.example.test' }));
  });

  it('guards a previously returned fetch when its config changes before the next call', async () => {
    const firstConfig = config();
    const firstFetch = createAgentFetch(firstConfig);
    firstConfig.privateKey = KEY_B;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(firstFetch(url)).rejects.toThrow(/configuration changed/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    firstConfig.privateKey = KEY_A;
    expect(createAgentFetch(firstConfig)).toBe(firstFetch);
  });

  it.each([
    ['privateKey', { privateKey: KEY_B }], ['accountAddress', { accountAddress: ADDRESS_B }],
    ['chain', { chain: 'arbitrum' as const }], ['rpcUrl', { rpcUrl: 'https://other-rpc.example.test' }],
    ['x402DailyLimit', { x402DailyLimit: 2_000_000n }],
  ])('rejects changes to cached %s without exposing key material', (_name, change) => {
    const firstConfig = config();
    getAgentWallet(firstConfig);
    Object.assign(firstConfig, change);
    let message = '';
    try {
      getAgentWallet(firstConfig);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/configuration changed/i);
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(KEY_B);
  });

  it.each(['0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', 'WBTC', 'WETH'])('rejects %s under its USDC daily limit', async (asset) => {
    respondWithPayment({ asset });
    const fetch = createAgentFetch(config());
    expect((await fetch(url)).status).toBe(402);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('ElizaOS runtime refresh', () => {
  it('isolates each runtime wallet, key, and payment client', async () => {
    const first = runtime();
    const second = runtime({ AGENT_PRIVATE_KEY: KEY_B, AGENT_ACCOUNT_ADDRESS: ADDRESS_B });
    await provider.get(first.runtime);
    await provider.get(second.runtime);

    expect(first.runtime.agentWallet).not.toBe(second.runtime.agentWallet);
    expect(first.runtime.x402Fetch).not.toBe(second.runtime.x402Fetch);
    expect(first.runtime.agentWallet!.walletClient.account!.address).toBe(privateKeyToAccount(KEY_A).address);
    expect(second.runtime.agentWallet!.walletClient.account!.address).toBe(privateKeyToAccount(KEY_B).address);
  });

  it('retains the same fetch and daily spend after provider refresh', async () => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const firstFetch = agent.runtime.x402Fetch!;
    const firstWallet = agent.runtime.agentWallet;
    const fetchMock = respondWithPayment();
    expect((await firstFetch(url)).status).toBe(200);
    expect(transfer).toHaveBeenCalledTimes(2);

    await provider.get(agent.runtime);
    fetchMock.mockRestore();
    respondWithPayment({ nonce: 'second-intent' });
    await expect(agent.runtime.x402Fetch!(url)).rejects.toThrow(/global daily limit/);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(agent.runtime.agentWallet).toBe(firstWallet);
    expect(agent.runtime.x402Fetch).toBe(firstFetch);
  });

  it('checks runtime identity again when a challenge arrives before paying the protocol fee', async () => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const firstFetch = agent.runtime.x402Fetch!;
    const fetchMock = respondWithPayment();
    const paymentResponse = await fetchMock.getMockImplementation()!(url);
    fetchMock.mockImplementationOnce(async () => {
      agent.settings.AGENT_PRIVATE_KEY = KEY_B;
      return paymentResponse;
    });

    await expect(firstFetch(url)).rejects.toThrow(/configuration changed/i);
    expect(transfer).not.toHaveBeenCalled();
    expect(agent.runtime.agentWallet).toBeUndefined();
    expect(agent.runtime.x402Fetch).toBeUndefined();
  });

  it('retains an unknown fee reservation through refresh and never pays it twice', async () => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const firstFetch = agent.runtime.x402Fetch!;
    const fetchMock = respondWithPayment();
    receipt.mockRejectedValueOnce(new Error('receipt timeout'));
    await expect(firstFetch(url)).rejects.toThrow('receipt timeout');
    expect(transfer).toHaveBeenCalledTimes(1);

    await provider.get(agent.runtime);
    fetchMock.mockRestore();
    const nextFetchMock = respondWithPayment({ nonce: 'unrelated-intent' });
    await expect(agent.runtime.x402Fetch!(url)).rejects.toThrow(/global daily limit/);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(agent.runtime.x402Fetch).toBe(firstFetch);

    nextFetchMock.mockRestore();
    respondWithPayment();
    expect((await agent.runtime.x402Fetch!(url)).status).toBe(200);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(receipt).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['AGENT_PRIVATE_KEY', KEY_B], ['AGENT_ACCOUNT_ADDRESS', ADDRESS_B],
    ['AGENT_CHAIN', 'arbitrum'], ['AGENT_RPC_URL', 'https://other-rpc.example.test'],
    ['X402_DAILY_LIMIT', '2000000'],
  ])('fails closed if %s changes and disables previously exposed fetch functions', async (name, value) => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const oldFetch = agent.runtime.x402Fetch!;
    agent.settings[name] = value;
    await expect(provider.get(agent.runtime)).rejects.toThrow(/configuration changed/i);
    expect(agent.runtime.agentWallet).toBeUndefined();
    expect(agent.runtime.x402Fetch).toBeUndefined();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(oldFetch(url)).rejects.toThrow(/configuration changed/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it('preserves an unknown hold when original settings are restored after a rejected change', async () => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const oldFetch = agent.runtime.x402Fetch!;
    const fetchMock = respondWithPayment();
    receipt.mockRejectedValueOnce(new Error('receipt timeout'));
    await expect(oldFetch(url)).rejects.toThrow('receipt timeout');
    agent.settings.X402_DAILY_LIMIT = '2000000';
    await expect(provider.get(agent.runtime)).rejects.toThrow(/configuration changed/i);
    agent.settings.X402_DAILY_LIMIT = '1000000';
    await provider.get(agent.runtime);
    expect(agent.runtime.x402Fetch).toBe(oldFetch);
    fetchMock.mockRestore();
    respondWithPayment({ nonce: 'unrelated-intent' });
    await expect(oldFetch(url)).rejects.toThrow(/global daily limit/);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('does not leave wallet capabilities exposed after settings are removed', async () => {
    const agent = runtime();
    await provider.get(agent.runtime);
    const oldFetch = agent.runtime.x402Fetch!;
    delete agent.settings.AGENT_PRIVATE_KEY;
    expect(await provider.get(agent.runtime)).toMatch(/not configured/);
    expect(agent.runtime.agentWallet).toBeUndefined();
    expect(agent.runtime.x402Fetch).toBeUndefined();
    await expect(oldFetch(url)).rejects.toThrow(/not configured/);
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe('ElizaOS retained submission recovery', () => {
  const feeHash = `0x${'aa'.repeat(32)}` as const;
  const payeeHash = `0x${'bb'.repeat(32)}` as const;
  const debit = 604620n;

  function loseSubmissionResponse(phase: 'fee' | 'payee') {
    const submissions: Array<{ hash: `0x${string}`; input: string; amount: bigint }> = [];
    let responseLost = false;
    transfer.mockImplementation(async (args) => {
      const [, to, amount] = args;
      const submittedPhase = to === X402_PROTOCOL_FEE_COLLECTOR ? 'fee' : 'payee';
      const hash = submittedPhase === 'fee' ? feeHash : payeeHash;
      const input = encodeFunctionData({ abi: AgentAccountV2Abi, functionName: 'agentTransferToken', args });
      submissions.push({ hash, input, amount });
      if (!responseLost && submittedPhase === phase) {
        responseLost = true;
        throw new Error('RPC response lost');
      }
      return hash;
    });
    transaction.mockImplementation(async ({ hash }) => {
      const submission = submissions.find(item => item.hash === hash)!;
      return {
        ...submission, chainId: 8453, to: ADDRESS_A, value: 0n,
        from: privateKeyToAccount(KEY_A).address,
      };
    });
    return submissions;
  }

  async function retainedSession(entrypoint: 'createAgentFetch' | 'runtime') {
    const cfg = config({ x402DailyLimit: debit });
    const agent = runtime({ X402_DAILY_LIMIT: debit.toString() });
    if (entrypoint === 'runtime') await provider.get(agent.runtime);
    const fetch = entrypoint === 'runtime' ? agent.runtime.x402Fetch! : createAgentFetch(cfg);
    const refresh = async () => {
      if (entrypoint === 'runtime') {
        await provider.get(agent.runtime);
        return agent.runtime.x402Fetch!;
      }
      return createAgentFetch(cfg);
    };
    return { cfg, agent, fetch, refresh };
  }

  it.each([
    ['createAgentFetch', 'fee'], ['createAgentFetch', 'payee'],
    ['runtime', 'fee'], ['runtime', 'payee'],
  ] as const)('%s recovers its original %s submission while preserving daily capacity', async (entrypoint, phase) => {
    const submissions = loseSubmissionResponse(phase);
    const session = await retainedSession(entrypoint);
    let fetchMock = respondWithPayment();
    const error = await session.fetch(url).catch(error => error);
    expect(error).toMatchObject({ name: 'X402SettlementUnknownError', phase });
    expect(await session.refresh()).toBe(session.fetch);
    expect(createWalletMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
    fetchMock = respondWithPayment({ nonce: 'unrelated-intent' });
    await expect(session.fetch(url)).rejects.toThrow(/global daily limit/);
    expect(submissions).toHaveLength(phase === 'fee' ? 1 : 2);

    expect(await session.fetch.reconcileSubmission({
      intentKey: error.intentKey, phase, txHash: phase === 'fee' ? feeHash : payeeHash,
    })).toBe('confirmed');
    await expect(session.fetch(url)).rejects.toThrow(/global daily limit/);
    fetchMock.mockRestore();
    fetchMock = respondWithPayment();
    expect((await session.fetch(url)).status).toBe(200);
    expect(submissions.map(item => item.amount)).toEqual([4620n, 600000n]);
    fetchMock.mockRestore();
    respondWithPayment({ nonce: 'unrelated-intent' });
    await expect(session.fetch(url)).rejects.toThrow(/global daily limit/);
    expect(submissions).toHaveLength(2);
  });

  it.each([
    ['createAgentFetch', 'privateKey', 'AGENT_PRIVATE_KEY', KEY_B],
    ['createAgentFetch', 'accountAddress', 'AGENT_ACCOUNT_ADDRESS', ADDRESS_B],
    ['createAgentFetch', 'chain', 'AGENT_CHAIN', 'arbitrum'],
    ['createAgentFetch', 'rpcUrl', 'AGENT_RPC_URL', 'https://other-rpc.example.test'],
    ['createAgentFetch', 'x402DailyLimit', 'X402_DAILY_LIMIT', '2000000'],
    ['runtime', 'privateKey', 'AGENT_PRIVATE_KEY', KEY_B],
    ['runtime', 'accountAddress', 'AGENT_ACCOUNT_ADDRESS', ADDRESS_B],
    ['runtime', 'chain', 'AGENT_CHAIN', 'arbitrum'],
    ['runtime', 'rpcUrl', 'AGENT_RPC_URL', 'https://other-rpc.example.test'],
    ['runtime', 'x402DailyLimit', 'X402_DAILY_LIMIT', '2000000'],
  ] as const)('%s rejects recovery when %s changes and keeps the retained hold available after restore', async (entrypoint, field, setting, value) => {
    const submissions = loseSubmissionResponse('fee');
    const session = await retainedSession(entrypoint);
    const fetchMock = respondWithPayment();
    const error = await session.fetch(url).catch(error => error);
    const originalConfig = { ...session.cfg };
    const originalSetting = session.agent.settings[setting];
    if (entrypoint === 'runtime') session.agent.settings[setting] = value;
    else Object.assign(session.cfg, { [field]: field === 'x402DailyLimit' ? BigInt(value) : value });

    await expect(session.fetch.reconcileSubmission({
      intentKey: error.intentKey, phase: 'fee', txHash: feeHash,
    })).rejects.toThrow(/configuration changed/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
    if (entrypoint === 'runtime') {
      expect(session.agent.runtime.agentWallet).toBeUndefined();
      expect(session.agent.runtime.x402Fetch).toBeUndefined();
      if (originalSetting === undefined) delete session.agent.settings[setting];
      else session.agent.settings[setting] = originalSetting;
    } else Object.assign(session.cfg, originalConfig, { [field]: originalConfig[field] });

    expect(await session.refresh()).toBe(session.fetch);
    expect(createWalletMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
    respondWithPayment({ nonce: 'unrelated-intent' });
    await expect(session.fetch(url)).rejects.toThrow(/global daily limit/);
    expect(submissions).toHaveLength(1);
    expect(await session.fetch.reconcileSubmission({
      intentKey: error.intentKey, phase: 'fee', txHash: feeHash,
    })).toBe('confirmed');
  });
});
