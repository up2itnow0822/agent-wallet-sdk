/**
 * Abstract x402 Delegated Payment Facilitator Adapter
 *
 * Abstract's x402 implementation uses a delegated facilitator pattern:
 * 1. The agent wallet does NOT sign the payment tx directly
 * 2. A "payment facilitator" contract is designated per-merchant
 * 3. The agent's wallet delegates authorization via a signed EIP-712 permit
 * 4. The facilitator executes the actual chain transaction
 *
 * Chain IDs:
 *   - Abstract Mainnet: 2741
 *   - Abstract Testnet: 11124
 */

import type { Address, Hex, WalletClient } from 'viem';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

// ─── Abstract Chain Constants ────────────────────────────────────────────────

export const ABSTRACT_CHAIN_IDS = {
  mainnet: 2741,
  testnet: 11124,
} as const;

/** USDC on Abstract Mainnet (official Bridged USDC) */
export const ABSTRACT_USDC: Record<number, Address> = {
  2741: '0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1', // Abstract Mainnet USDC
  11124: '0x3eBDeaA0DB3FfDe96E7a0DBBAFEC961FC50F725F', // Abstract Testnet USDC
};

/**
 * Anvil/Hardhat first-deployment address (account 0, nonce 0).
 * Valid as a local/testnet fixture only. Not an Abstract mainnet contract.
 */
export const ABSTRACT_ANVIL_FACILITATOR: Address =
  '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/**
 * Approved Abstract mainnet facilitators.
 * Empty until a verified mainnet contract address is configured.
 * Do not invent or copy a local-dev address here.
 */
export const ABSTRACT_APPROVED_FACILITATORS: Address[] = [];

/** Approved Abstract testnet facilitators (local Anvil first-deployment address). */
export const ABSTRACT_TESTNET_APPROVED_FACILITATORS: Address[] = [
  ABSTRACT_ANVIL_FACILITATOR,
];

function addressesInclude(list: readonly Address[], address: Address): boolean {
  const target = address.toLowerCase();
  return list.some((a) => a.toLowerCase() === target);
}

/** Official approved-facilitator list for the given Abstract chain. */
export function getAbstractApprovedFacilitators(chainId: number): readonly Address[] {
  if (chainId === ABSTRACT_CHAIN_IDS.testnet) {
    return ABSTRACT_TESTNET_APPROVED_FACILITATORS;
  }
  if (chainId === ABSTRACT_CHAIN_IDS.mainnet) {
    return ABSTRACT_APPROVED_FACILITATORS;
  }
  return [];
}

/**
 * Fail-closed facilitator check.
 * Mainnet rejects every address against the official list until a verified
 * facilitator is configured. `userAllowlist` is an explicit caller opt-in
 * and does not populate the official mainnet list.
 */
export function assertAbstractFacilitatorApproved(
  facilitatorAddress: Address,
  chainId: number,
  userAllowlist: readonly Address[] = [],
): void {
  if (addressesInclude(userAllowlist, facilitatorAddress)) {
    return;
  }

  const approved = getAbstractApprovedFacilitators(chainId);

  if (chainId === ABSTRACT_CHAIN_IDS.mainnet && approved.length === 0) {
    throw new Error(
      `No verified Abstract mainnet facilitator is configured. ` +
      `Mainnet facilitator checks fail closed until a verified address is added. ` +
      `Rejected facilitator ${facilitatorAddress}. ` +
      `Do not treat the Anvil/Hardhat default deployment address ` +
      `${ABSTRACT_ANVIL_FACILITATOR} as an official mainnet facilitator. ` +
      `Pass a caller-verified contract in userAllowlist to opt in explicitly.`,
    );
  }

  if (!addressesInclude(approved, facilitatorAddress)) {
    throw new Error(
      `Facilitator ${facilitatorAddress} is not on the Abstract approved list. ` +
      `Pass it in userAllowlist to explicitly allow it.`,
    );
  }
}

// ─── EIP-712 Types for Abstract Delegated Payment ───────────────────────────

const ABSTRACT_PERMIT_DOMAIN = {
  name: 'AbstractDelegatedPayment',
  version: '1',
  chainId: ABSTRACT_CHAIN_IDS.mainnet,
} as const;

const ABSTRACT_PERMIT_TYPES = {
  DelegatedPaymentPermit: [
    { name: 'facilitator', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'resource', type: 'string' },
  ],
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AbstractDelegatedPaymentConfig {
  /** The facilitator contract address (must be on approved list or user-allowlisted) */
  facilitatorAddress: Address;
  /** Token to pay with (default: USDC on Abstract) */
  token?: Address;
  /** Permit deadline in seconds from now (default: 300 = 5 min) */
  deadlineSeconds?: number;
  /** User-allowlisted facilitator addresses (extends the approved list) */
  userAllowlist?: Address[];
}

export interface DelegatedPaymentPermit {
  facilitator: Address;
  token: Address;
  amount: bigint;
  payTo: Address;
  nonce: bigint;
  deadline: bigint;
  resource: string;
}

export interface AbstractPaymentResult {
  /** EIP-712 signature for the facilitator permit */
  permitSignature: Hex;
  /** Encoded permit data to submit to the facilitator contract */
  permitData: Hex;
  /** The permit fields for verification */
  permit: DelegatedPaymentPermit;
  /** Chain ID this payment is valid on */
  chainId: number;
}

// ─── AbstractDelegatedFacilitatorAdapter ─────────────────────────────────────

/**
 * Adapter for Abstract's delegated payment facilitator x402 model.
 *
 * Instead of signing a direct payment transaction, the agent signs an EIP-712
 * permit authorizing a facilitator contract to execute the payment on its behalf.
 * This is Abstract's model — the agent's keys never touch the chain directly.
 *
 * @example
 * ```typescript
 * // Mainnet has no verified facilitator yet and fail-closes.
 * // Testnet accepts the Anvil/Hardhat first-deployment address.
 * const adapter = new AbstractDelegatedFacilitatorAdapter(
 *   walletClient,
 *   { facilitatorAddress: ABSTRACT_TESTNET_APPROVED_FACILITATORS[0] },
 *   ABSTRACT_CHAIN_IDS.testnet,
 * );
 *
 * const result = await adapter.signPaymentPermit({
 *   amount: 1_000_000n, // 1 USDC (6 decimals)
 *   payTo: '0xmerchant...',
 *   nonce: 0n,
 *   resource: 'https://api.example.com/resource',
 * });
 * ```
 */
export class AbstractDelegatedFacilitatorAdapter {
  private walletClient: WalletClient;
  private config: Required<AbstractDelegatedPaymentConfig>;
  private chainId: number;

  constructor(
    walletClient: WalletClient,
    config: AbstractDelegatedPaymentConfig,
    chainId: number = ABSTRACT_CHAIN_IDS.mainnet
  ) {
    this.walletClient = walletClient;
    this.chainId = chainId;

    assertAbstractFacilitatorApproved(
      config.facilitatorAddress,
      chainId,
      config.userAllowlist ?? [],
    );

    this.config = {
      facilitatorAddress: config.facilitatorAddress,
      token: config.token ?? ABSTRACT_USDC[chainId] ?? ABSTRACT_USDC[ABSTRACT_CHAIN_IDS.mainnet],
      deadlineSeconds: config.deadlineSeconds ?? 300,
      userAllowlist: config.userAllowlist ?? [],
    };
  }

  /**
   * Sign an EIP-712 delegated payment permit for the Abstract facilitator.
   * This replaces direct tx signing — the permit is submitted to the facilitator contract.
   */
  async signPaymentPermit(params: {
    amount: bigint;
    payTo: Address;
    nonce: bigint;
    resource: string;
  }): Promise<AbstractPaymentResult> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.config.deadlineSeconds);

    const permit: DelegatedPaymentPermit = {
      facilitator: this.config.facilitatorAddress,
      token: this.config.token,
      amount: params.amount,
      payTo: params.payTo,
      nonce: params.nonce,
      deadline,
      resource: params.resource,
    };

    const domain = {
      ...ABSTRACT_PERMIT_DOMAIN,
      chainId: this.chainId,
    };

    const account = this.walletClient.account;
    if (!account) throw new Error('WalletClient has no account attached');

    const signature = await this.walletClient.signTypedData({
      account,
      domain,
      types: ABSTRACT_PERMIT_TYPES,
      primaryType: 'DelegatedPaymentPermit',
      message: permit,
    });

    // Encode the permit for submission to the facilitator contract
    const permitData = encodeAbiParameters(
      parseAbiParameters('address facilitator, address token, uint256 amount, address payTo, uint256 nonce, uint256 deadline, string resource, bytes signature'),
      [
        permit.facilitator,
        permit.token,
        permit.amount,
        permit.payTo,
        permit.nonce,
        permit.deadline,
        permit.resource,
        signature,
      ]
    );

    return {
      permitSignature: signature,
      permitData,
      permit,
      chainId: this.chainId,
    };
  }

  /**
   * Build the x402 payment payload for Abstract's delegated facilitator model.
   * This payload replaces the standard txHash payload in the X-PAYMENT header.
   */
  async buildX402Payload(params: {
    amount: bigint;
    payTo: Address;
    nonce: bigint;
    resource: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.signPaymentPermit(params);

    return {
      scheme: 'abstract-delegated',
      chainId: result.chainId,
      facilitator: result.permit.facilitator,
      token: result.permit.token,
      amount: result.permit.amount.toString(),
      payTo: result.permit.payTo,
      nonce: result.permit.nonce.toString(),
      deadline: result.permit.deadline.toString(),
      resource: result.permit.resource,
      permitSignature: result.permitSignature,
      permitData: result.permitData,
    };
  }

  /** Check if a chain ID is an Abstract chain */
  static isAbstractChain(chainId: number): boolean {
    return Object.values(ABSTRACT_CHAIN_IDS).includes(chainId as 2741 | 11124);
  }

  /** Get the network string for x402 payment requirements (e.g. "abstract:2741") */
  static getNetworkString(chainId: number): string {
    return `abstract:${chainId}`;
  }
}

// ─── SUPPORTED_CHAINS Extension ──────────────────────────────────────────────

/**
 * Abstract chain IDs to add to SUPPORTED_CHAINS in the main SDK.
 * These route through AbstractDelegatedFacilitatorAdapter for x402 payments.
 */
export const ABSTRACT_SUPPORTED_CHAINS = {
  'abstract:2741': {
    chainId: ABSTRACT_CHAIN_IDS.mainnet,
    name: 'Abstract Mainnet',
    rpcUrl: 'https://api.mainnet.abs.xyz',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://explorer.mainnet.abs.xyz',
    x402Model: 'delegated-facilitator' as const,
    usdc: ABSTRACT_USDC[ABSTRACT_CHAIN_IDS.mainnet],
  },
  'abstract-testnet:11124': {
    chainId: ABSTRACT_CHAIN_IDS.testnet,
    name: 'Abstract Testnet',
    rpcUrl: 'https://api.testnet.abs.xyz',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://explorer.testnet.abs.xyz',
    x402Model: 'delegated-facilitator' as const,
    usdc: ABSTRACT_USDC[ABSTRACT_CHAIN_IDS.testnet],
  },
} as const;
