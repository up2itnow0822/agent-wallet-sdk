/**
 * Integration tests — Abstract x402 Delegated Payment Facilitator Adapter
 *
 * Tests the AbstractDelegatedFacilitatorAdapter's EIP-712 permit signing flow.
 * Uses a mock WalletClient to avoid requiring a live Abstract RPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AbstractDelegatedFacilitatorAdapter,
  ABSTRACT_CHAIN_IDS,
  ABSTRACT_USDC,
  ABSTRACT_APPROVED_FACILITATORS,
  ABSTRACT_SUPPORTED_CHAINS,
} from '../../src/x402/chains/abstract/index.js';

// ─── Mock WalletClient ────────────────────────────────────────────────────────

const MOCK_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;
const MOCK_SIGNATURE = '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc1b' as `0x${string}`;

const mockWalletClient = {
  account: { address: MOCK_ACCOUNT },
  signTypedData: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
};

// ─── Test Constants ───────────────────────────────────────────────────────────

const MOCK_FACILITATOR = ABSTRACT_APPROVED_FACILITATORS[0];
const MOCK_MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`;
const MOCK_AMOUNT = 1_000_000n; // 1 USDC
const MOCK_NONCE = 0n;
const MOCK_RESOURCE = 'https://api.example.com/premium-resource';

// ─── Chain ID Tests ───────────────────────────────────────────────────────────

describe('Abstract Chain Constants', () => {
  it('has correct mainnet chain ID (2741)', () => {
    expect(ABSTRACT_CHAIN_IDS.mainnet).toBe(2741);
  });

  it('has correct testnet chain ID (11124)', () => {
    expect(ABSTRACT_CHAIN_IDS.testnet).toBe(11124);
  });

  it('has USDC addresses for both chains', () => {
    expect(ABSTRACT_USDC[2741]).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(ABSTRACT_USDC[11124]).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('includes abstract:2741 in SUPPORTED_CHAINS', () => {
    expect(ABSTRACT_SUPPORTED_CHAINS['abstract:2741']).toBeDefined();
    expect(ABSTRACT_SUPPORTED_CHAINS['abstract:2741'].chainId).toBe(2741);
    expect(ABSTRACT_SUPPORTED_CHAINS['abstract:2741'].x402Model).toBe('delegated-facilitator');
  });

  it('includes abstract-testnet:11124 in SUPPORTED_CHAINS', () => {
    expect(ABSTRACT_SUPPORTED_CHAINS['abstract-testnet:11124']).toBeDefined();
    expect(ABSTRACT_SUPPORTED_CHAINS['abstract-testnet:11124'].chainId).toBe(11124);
  });
});

// ─── Adapter Instantiation Tests ──────────────────────────────────────────────

describe('AbstractDelegatedFacilitatorAdapter — instantiation', () => {
  it('creates adapter with approved facilitator', () => {
    const adapter = new AbstractDelegatedFacilitatorAdapter(
      mockWalletClient as any,
      { facilitatorAddress: MOCK_FACILITATOR },
      ABSTRACT_CHAIN_IDS.mainnet
    );
    expect(adapter).toBeDefined();
  });

  it('throws when facilitator is not approved and not in userAllowlist', () => {
    const unapproved = '0x1234567890123456789012345678901234567890' as `0x${string}`;
    expect(() =>
      new AbstractDelegatedFacilitatorAdapter(
        mockWalletClient as any,
        { facilitatorAddress: unapproved },
        ABSTRACT_CHAIN_IDS.mainnet
      )
    ).toThrow('not on the Abstract approved list');
  });

  it('creates adapter with user-allowlisted facilitator', () => {
    const customFacilitator = '0x1234567890123456789012345678901234567890' as `0x${string}`;
    const adapter = new AbstractDelegatedFacilitatorAdapter(
      mockWalletClient as any,
      {
        facilitatorAddress: customFacilitator,
        userAllowlist: [customFacilitator],
      },
      ABSTRACT_CHAIN_IDS.mainnet
    );
    expect(adapter).toBeDefined();
  });
});

// ─── Permit Signing Tests ─────────────────────────────────────────────────────

describe('AbstractDelegatedFacilitatorAdapter — permit signing', () => {
  let adapter: AbstractDelegatedFacilitatorAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AbstractDelegatedFacilitatorAdapter(
      mockWalletClient as any,
      { facilitatorAddress: MOCK_FACILITATOR },
      ABSTRACT_CHAIN_IDS.mainnet
    );
  });

  it('signs a payment permit with EIP-712', async () => {
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(mockWalletClient.signTypedData).toHaveBeenCalledOnce();
    expect(result.permitSignature).toBe(MOCK_SIGNATURE);
    expect(result.chainId).toBe(ABSTRACT_CHAIN_IDS.mainnet);
  });

  it('permit includes correct fields', async () => {
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(result.permit.facilitator).toBe(MOCK_FACILITATOR);
    expect(result.permit.token).toBe(ABSTRACT_USDC[ABSTRACT_CHAIN_IDS.mainnet]);
    expect(result.permit.amount).toBe(MOCK_AMOUNT);
    expect(result.permit.payTo).toBe(MOCK_MERCHANT);
    expect(result.permit.nonce).toBe(MOCK_NONCE);
    expect(result.permit.resource).toBe(MOCK_RESOURCE);
    expect(result.permit.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it('sets deadline ~5 minutes in the future by default', async () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });
    const after = BigInt(Math.floor(Date.now() / 1000));

    expect(result.permit.deadline).toBeGreaterThanOrEqual(before + 299n);
    expect(result.permit.deadline).toBeLessThanOrEqual(after + 301n);
  });

  it('encodes permitData as hex bytes', async () => {
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(result.permitData).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(result.permitData.length).toBeGreaterThan(10);
  });

  it('uses custom token when provided', async () => {
    const customToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`; // USDC on mainnet (valid checksum)
    const customAdapter = new AbstractDelegatedFacilitatorAdapter(
      mockWalletClient as any,
      {
        facilitatorAddress: MOCK_FACILITATOR,
        token: customToken,
      },
      ABSTRACT_CHAIN_IDS.mainnet
    );

    const result = await customAdapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(result.permit.token).toBe(customToken);
  });
});

// ─── x402 Payload Tests ───────────────────────────────────────────────────────

describe('AbstractDelegatedFacilitatorAdapter — x402 payload', () => {
  let adapter: AbstractDelegatedFacilitatorAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AbstractDelegatedFacilitatorAdapter(
      mockWalletClient as any,
      { facilitatorAddress: MOCK_FACILITATOR },
      ABSTRACT_CHAIN_IDS.mainnet
    );
  });

  it('builds a complete x402 payload for Abstract', async () => {
    const payload = await adapter.buildX402Payload({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(payload.scheme).toBe('abstract-delegated');
    expect(payload.chainId).toBe(ABSTRACT_CHAIN_IDS.mainnet);
    expect(payload.facilitator).toBe(MOCK_FACILITATOR);
    expect(payload.permitSignature).toBe(MOCK_SIGNATURE);
    expect(payload.amount).toBe(MOCK_AMOUNT.toString());
  });

  it('payload amount is string (JSON-safe)', async () => {
    const payload = await adapter.buildX402Payload({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(typeof payload.amount).toBe('string');
    expect(typeof payload.nonce).toBe('string');
    expect(typeof payload.deadline).toBe('string');
  });
});

// ─── Static Utility Tests ─────────────────────────────────────────────────────

describe('AbstractDelegatedFacilitatorAdapter — static utilities', () => {
  it('isAbstractChain returns true for mainnet', () => {
    expect(AbstractDelegatedFacilitatorAdapter.isAbstractChain(2741)).toBe(true);
  });

  it('isAbstractChain returns true for testnet', () => {
    expect(AbstractDelegatedFacilitatorAdapter.isAbstractChain(11124)).toBe(true);
  });

  it('isAbstractChain returns false for other chains', () => {
    expect(AbstractDelegatedFacilitatorAdapter.isAbstractChain(1)).toBe(false);
    expect(AbstractDelegatedFacilitatorAdapter.isAbstractChain(8453)).toBe(false);
    expect(AbstractDelegatedFacilitatorAdapter.isAbstractChain(137)).toBe(false);
  });

  it('getNetworkString formats correctly', () => {
    expect(AbstractDelegatedFacilitatorAdapter.getNetworkString(2741)).toBe('abstract:2741');
    expect(AbstractDelegatedFacilitatorAdapter.getNetworkString(11124)).toBe('abstract:11124');
  });
});
