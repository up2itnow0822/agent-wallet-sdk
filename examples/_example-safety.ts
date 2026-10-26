/**
 * Shared guard rails for the runnable examples.
 *
 * - Examples default to Base Sepolia (testnet) and testnet USDC.
 * - Base mainnet requires BOTH `AGENT_EXAMPLE_NETWORK=base` and
 *   `AGENT_EXAMPLE_LIVE_ACK=I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS`.
 * - Examples export their entry points; they only run when executed directly.
 * - Before any agent write, the advertised on-chain spend policy must already
 *   be installed (by the wallet owner) and be no looser than the example's limits.
 */
import { pathToFileURL } from 'node:url';
import type { Address, Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { AgentWalletHandle } from '../src/index.js';

export const LIVE_ACK = 'I_UNDERSTAND_THIS_SPENDS_REAL_FUNDS';

export interface ExampleNetwork {
  chainKey: 'base' | 'base-sepolia';
  chain: Chain;
  usdc: Address;
  live: boolean;
}

export function resolveExampleNetwork(env: NodeJS.ProcessEnv = process.env): ExampleNetwork {
  const requested = (env.AGENT_EXAMPLE_NETWORK ?? 'base-sepolia').trim();
  if (requested === 'base-sepolia') {
    return {
      chainKey: 'base-sepolia',
      chain: baseSepolia,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      live: false,
    };
  }
  if (requested === 'base') {
    if (env.AGENT_EXAMPLE_LIVE_ACK !== LIVE_ACK) {
      throw new Error(
        `Refusing to run on Base mainnet. Set AGENT_EXAMPLE_LIVE_ACK=${LIVE_ACK} to spend real funds.`,
      );
    }
    return {
      chainKey: 'base',
      chain: base,
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      live: true,
    };
  }
  throw new Error(`Unsupported AGENT_EXAMPLE_NETWORK "${requested}" (use base-sepolia or base)`);
}

/** True only when this module is the process entry point (not when imported). */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && moduleUrl === pathToFileURL(entry).href;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Verify, before any write, that the wallet owner has installed an on-chain
 * spend policy for `token` that is no looser than the advertised limits.
 */
export async function assertInstalledSpendPolicy(
  wallet: AgentWalletHandle,
  token: Address,
  limits: { perTx: bigint; perDay: bigint },
): Promise<void> {
  const [perTxLimit, periodLimit] = await wallet.contract.read.spendPolicies([token]);
  if (perTxLimit === 0n && periodLimit === 0n) {
    throw new Error(
      `No on-chain spend policy for ${token}. The owner must call setSpendPolicy ` +
        `(perTx ${limits.perTx}, perDay ${limits.perDay}) before this example spends.`,
    );
  }
  if (perTxLimit > limits.perTx || periodLimit > limits.perDay) {
    throw new Error(
      `Installed policy (perTx ${perTxLimit}, period ${periodLimit}) is looser than the ` +
        `advertised limits (perTx ${limits.perTx}, perDay ${limits.perDay}); refusing to spend.`,
    );
  }
}
