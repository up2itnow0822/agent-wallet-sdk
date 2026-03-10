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
  createX402Fetch,
} from '../index.js';
import type { AgentWalletConfig } from '../types.js';
// AgentWallet type alias for backward compat
type AgentWallet = ReturnType<typeof createWallet>;
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface AgentWalletPluginConfig {
  /** Agent private key — stays in your environment, never transmitted */
  privateKey: `0x${string}`;
  /** Deployed AgentAccountV2 contract address */
  accountAddress: `0x${string}`;
  /** Chain to connect to (default: 'base') */
  chain?: 'base' | 'base-sepolia' | 'ethereum' | 'arbitrum' | 'polygon' | 'etherlink';
  /** Optional custom RPC URL */
  rpcUrl?: string;
  /** Optional daily x402 spend limit in USDC base units (default: 50 USDC = 50_000_000n) */
  x402DailyLimit?: bigint;
}

let walletInstance: AgentWallet | null = null;

/**
 * Get or create the agent wallet singleton.
 */
export function getAgentWallet(config: AgentWalletPluginConfig): AgentWallet {
  if (!walletInstance) {
    const account = privateKeyToAccount(config.privateKey);
    const rpcUrls: Record<string, string> = {
      base: 'https://mainnet.base.org',
      'base-sepolia': 'https://sepolia.base.org',
      ethereum: 'https://eth.llamarpc.com',
      arbitrum: 'https://arb1.arbitrum.io/rpc',
      polygon: 'https://polygon-rpc.com',
      etherlink: 'https://node.mainnet.etherlink.com',
    };
    const chain = config.chain ?? 'base';
    const walletClient = createWalletClient({
      account,
      transport: http(config.rpcUrl ?? rpcUrls[chain] ?? rpcUrls.base),
    });
    walletInstance = createWallet({
      accountAddress: config.accountAddress,
      chain,
      walletClient,
    });
  }
  return walletInstance;
}

/**
 * Create an x402-enabled fetch function for the agent to pay APIs automatically.
 */
export function createAgentFetch(config: AgentWalletPluginConfig) {
  const wallet = getAgentWallet(config);
  return createX402Fetch(wallet, {
    globalDailyLimit: config.x402DailyLimit ?? 50_000_000n, // 50 USDC default
  });
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
        const privateKey = runtime.getSetting('AGENT_PRIVATE_KEY') as `0x${string}`;
        const accountAddress = runtime.getSetting('AGENT_ACCOUNT_ADDRESS') as `0x${string}`;
        const chain = (runtime.getSetting('AGENT_CHAIN') ?? 'base') as AgentWalletPluginConfig['chain'];
        const dailyLimitStr = runtime.getSetting('X402_DAILY_LIMIT');
        const x402DailyLimit = dailyLimitStr ? BigInt(dailyLimitStr) : 50_000_000n;

        if (!privateKey || !accountAddress) {
          return 'AgentWallet not configured: AGENT_PRIVATE_KEY and AGENT_ACCOUNT_ADDRESS required.';
        }

        const config: AgentWalletPluginConfig = { privateKey, accountAddress, chain, x402DailyLimit };
        const wallet = getAgentWallet(config);
        const x402Fetch = createAgentFetch(config);

        // Expose on runtime for actions to use
        (runtime as any).agentWallet = wallet;
        (runtime as any).x402Fetch = x402Fetch;

        return `AgentWallet ready — non-custodial, keys stay local. Chain: ${chain}. x402 daily limit: ${x402DailyLimit / 1_000_000n} USDC.`;
      },
    },
  ],
  evaluators: [],
};

export default AgentWalletPlugin;
export { AgentWalletPlugin };
