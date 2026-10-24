/**
 * @elizaos/plugin-agentwallet
 *
 * ElizaOS plugin for agentwallet-sdk — non-custodial AI agent wallet with
 * x402 payment support, CCTP V2 cross-chain transfers, and on-chain spend limits.
 *
 * Your agent holds its own private key. No custodian. No KYC.
 */
import type { Plugin } from '@elizaos/core';
import {
  createWallet,
  createX402Client,
  USDC_ADDRESSES,
} from '../index.js';
import type { AgentWalletConfig } from '../types.js';
import type { X402Fetch } from '../x402/middleware.js';
// AgentWallet type alias for backward compat
type AgentWallet = ReturnType<typeof createWallet>;
import { createWalletClient, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  base, baseSepolia, mainnet, arbitrum, polygon, optimism, avalanche,
  unichain, linea, sonic, worldchain,
} from 'viem/chains';

export interface AgentWalletPluginConfig {
  /** Agent private key — stays in your environment, never transmitted */
  privateKey: `0x${string}`;
  /** Deployed AgentAccountV2 contract address */
  accountAddress: `0x${string}`;
  /** Chain to connect to (default: 'base') */
  chain?: AgentWalletConfig['chain'];
  /** Optional custom RPC URL */
  rpcUrl?: string;
  /** Optional daily x402 spend limit in USDC base units (default: 50 USDC = 50_000_000n) */
  x402DailyLimit?: bigint;
}

const CHAINS = {
  base, 'base-sepolia': baseSepolia, ethereum: mainnet, arbitrum, polygon,
  optimism, avalanche, unichain, linea, sonic, worldchain,
};

const RPC_URLS: Partial<Record<AgentWalletConfig['chain'], string>> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  ethereum: 'https://eth.llamarpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  polygon: 'https://polygon-rpc.com',
};

/** Cache identities contain the public signer address, never a raw private key. */
type ConfigIdentity = {
  signer: string;
  accountAddress: string;
  chain: AgentWalletConfig['chain'];
  rpcUrl: string;
  dailyLimit: bigint;
};

type AgentSession = {
  identity: ConfigIdentity;
  wallet: AgentWallet;
  fetch: X402Fetch;
};

const configSessions = new WeakMap<AgentWalletPluginConfig, AgentSession>();
const runtimeSessions = new WeakMap<object, AgentSession>();

function resolveConfig(config: AgentWalletPluginConfig) {
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(config.privateKey);
  } catch {
    throw new Error('AgentWallet private key is invalid.');
  }
  if (!isAddress(config.accountAddress, { strict: false })) {
    throw new Error('AgentWallet account address is invalid.');
  }
  const chain = config.chain ?? 'base';
  const chainInfo = CHAINS[chain];
  if (!chainInfo) throw new Error('AgentWallet chain is unsupported.');
  const rpcUrl = config.rpcUrl ?? RPC_URLS[chain] ?? chainInfo.rpcUrls.default.http[0];
  const dailyLimit = config.x402DailyLimit ?? 50_000_000n;
  if (typeof dailyLimit !== 'bigint' || dailyLimit < 0n) {
    throw new Error('AgentWallet x402 daily limit must be a non-negative bigint.');
  }
  const deployment = Object.entries(USDC_ADDRESSES).find(([network]) => (
    Number(network.split(':')[1]) === chainInfo.id
  ));
  if (!deployment) throw new Error('AgentWallet has no configured USDC deployment for its chain.');
  return {
    account, chainInfo, network: deployment[0], token: deployment[1],
    identity: {
      signer: account.address.toLowerCase(), accountAddress: config.accountAddress.toLowerCase(),
      chain, rpcUrl, dailyLimit,
    } satisfies ConfigIdentity,
  };
}

function assertIdentity(expected: ConfigIdentity, actual: ConfigIdentity): void {
  if (
    expected.signer !== actual.signer || expected.accountAddress !== actual.accountAddress
    || expected.chain !== actual.chain || expected.rpcUrl !== actual.rpcUrl
    || expected.dailyLimit !== actual.dailyLimit
  ) {
    throw new Error(
      'AgentWallet configuration changed for this cache scope. ' +
      'Restore the original settings or use a new config object/runtime.',
    );
  }
}

function createSession(resolved: ReturnType<typeof resolveConfig>, assertConfiguration: () => void): AgentSession {
  const { identity, account, chainInfo, network, token } = resolved;
  const walletClient = createWalletClient({ account, chain: chainInfo, transport: http(identity.rpcUrl) });
  const wallet = createWallet({
    accountAddress: identity.accountAddress as AgentWalletPluginConfig['accountAddress'],
    chain: identity.chain,
    rpcUrl: identity.rpcUrl,
    walletClient,
  });
  // All limits are USDC base units. Never admit registry tokens with other units.
  const client = createX402Client(wallet, {
    globalDailyLimit: identity.dailyLimit,
    supportedNetworks: [network],
    supportedAssets: { [network]: [token] },
    onBeforePayment: () => {
      assertConfiguration();
      return true;
    },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assertConfiguration();
    return client.fetch(input, init);
  };
  const reconcileSubmission: X402Fetch['reconcileSubmission'] = async (params) => {
    assertConfiguration();
    return client.reconcileSubmission(params);
  };
  return { identity, wallet, fetch: Object.assign(fetch, { reconcileSubmission }) };
}

function getConfigSession(config: AgentWalletPluginConfig): AgentSession {
  const resolved = resolveConfig(config);
  const existing = configSessions.get(config);
  if (existing) {
    assertIdentity(existing.identity, resolved.identity);
    return existing;
  }
  const session = createSession(resolved, () => assertIdentity(resolved.identity, resolveConfig(config).identity));
  configSessions.set(config, session);
  return session;
}

function clearRuntimeCapabilities(runtime: any): void {
  delete runtime.agentWallet;
  delete runtime.x402Fetch;
}

function readRuntimeConfig(runtime: any): AgentWalletPluginConfig | null {
  const privateKey = runtime.getSetting('AGENT_PRIVATE_KEY') as `0x${string}` | undefined;
  const accountAddress = runtime.getSetting('AGENT_ACCOUNT_ADDRESS') as `0x${string}` | undefined;
  if (!privateKey || !accountAddress) return null;
  const dailyLimitStr = runtime.getSetting('X402_DAILY_LIMIT');
  let x402DailyLimit: bigint;
  try {
    x402DailyLimit = dailyLimitStr ? BigInt(dailyLimitStr) : 50_000_000n;
  } catch {
    throw new Error('AgentWallet X402_DAILY_LIMIT must be an integer in USDC base units.');
  }
  return {
    privateKey, accountAddress,
    chain: (runtime.getSetting('AGENT_CHAIN') ?? 'base') as AgentWalletPluginConfig['chain'],
    rpcUrl: runtime.getSetting('AGENT_RPC_URL') ?? undefined,
    x402DailyLimit,
  };
}

function assertRuntimeConfiguration(runtime: any, identity: ConfigIdentity): void {
  try {
    const config = readRuntimeConfig(runtime);
    if (!config) throw new Error('AgentWallet not configured: AGENT_PRIVATE_KEY and AGENT_ACCOUNT_ADDRESS required.');
    assertIdentity(identity, resolveConfig(config).identity);
  } catch (error) {
    clearRuntimeCapabilities(runtime);
    throw error;
  }
}

/**
 * Get or create the wallet for this config object. Reuse the same object for
 * one agent; separate objects have separate wallets and payment budgets.
 * Mutating an initialized config is rejected without replacing its client.
 */
export function getAgentWallet(config: AgentWalletPluginConfig): AgentWallet {
  return getConfigSession(config).wallet;
}

/**
 * Return this config object's retained x402 fetch function. Its daily totals
 * and unknown settlements survive repeated helper calls. Auto-payment accepts
 * only this chain's configured USDC address. Old fetch references reject a
 * changed config too; restore the original values to resume the retained state.
 * Its reconcileSubmission method uses the same guards and original payment holds.
 */
export function createAgentFetch(config: AgentWalletPluginConfig): X402Fetch {
  return getConfigSession(config).fetch;
}

/**
 * ElizaOS Plugin definition for agentwallet-sdk.
 *
 * Usage in your Eliza character config:
 *
 * ```json
 * {
 *   "plugins": ["@elizaos/plugin-agentwallet"],
 *   "settings": {
 *     "AGENT_PRIVATE_KEY": "0x...",
 *     "AGENT_ACCOUNT_ADDRESS": "0x...",
 *     "AGENT_CHAIN": "base",
 *     "X402_DAILY_LIMIT": "50000000"
 *   }
 * }
 * ```
 */
const AgentWalletPlugin: Plugin = {
  name: '@elizaos/plugin-agentwallet',
  description:
    'Non-custodial agent wallet for ElizaOS — x402 payments, CCTP cross-chain, on-chain spend limits. Agent holds its own keys.',
  actions: [],
  providers: [
    {
      name: 'agentWallet',
      description: 'Provides agent wallet and x402 fetch capability to the runtime',
      async get(runtime: any) {
        try {
          const config = readRuntimeConfig(runtime);
          if (!config) {
            clearRuntimeCapabilities(runtime);
            return 'AgentWallet not configured: AGENT_PRIVATE_KEY and AGENT_ACCOUNT_ADDRESS required.';
          }
          const resolved = resolveConfig(config);
          let session = runtimeSessions.get(runtime);
          if (session) {
            assertIdentity(session.identity, resolved.identity);
          } else {
            session = createSession(resolved, () => assertRuntimeConfiguration(runtime, resolved.identity));
            runtimeSessions.set(runtime, session);
          }
          runtime.agentWallet = session.wallet;
          runtime.x402Fetch = session.fetch;
          return `AgentWallet ready — non-custodial, keys stay local. Chain: ${session.identity.chain}. x402 daily limit: ${session.identity.dailyLimit / 1_000_000n} USDC.`;
        } catch (error) {
          clearRuntimeCapabilities(runtime);
          throw error;
        }
      },
    },
  ],
  evaluators: [],
};

export default AgentWalletPlugin;
export { AgentWalletPlugin };
