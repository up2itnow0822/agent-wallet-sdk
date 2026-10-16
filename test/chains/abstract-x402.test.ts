/**
 * Integration tests — Abstract x402 Delegated Payment Facilitator Adapter
 *
 * Uses a local viem account so EIP-712 signing is real. No live Abstract RPC
 * or funds: the transport is pointed at a local URL and never broadcast.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWalletClient, getAddress, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AbstractDelegatedFacilitatorAdapter,
  ABSTRACT_CHAIN_IDS,
  ABSTRACT_USDC,
  ABSTRACT_ANVIL_FACILITATOR,
  ABSTRACT_APPROVED_FACILITATORS,
  ABSTRACT_TESTNET_APPROVED_FACILITATORS,
  ABSTRACT_SUPPORTED_CHAINS,
  getAbstractApprovedFacilitators,
  assertAbstractFacilitatorApproved,
} from '../../src/x402/chains/abstract/index.js';

// Well-known Anvil account 0. Public test key; never used with live funds.
const TEST_ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

function createLocalWalletClient(): WalletClient {
  return createWalletClient({
    account: TEST_ACCOUNT,
    transport: http('http://127.0.0.1:8545'),
  });
}

const TESTNET_FACILITATOR = ABSTRACT_TESTNET_APPROVED_FACILITATORS[0];
const MOCK_MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`;
const MOCK_AMOUNT = 1_000_000n; // 1 USDC
const MOCK_NONCE = 0n;
const MOCK_RESOURCE = 'https://api.example.com/premium-resource';
const UNAPPROVED = '0x1234567890123456789012345678901234567890' as `0x${string}`;

describe('Abstract Chain Constants', () => {
  it('has correct mainnet chain ID (2741)', () => {
    expect(ABSTRACT_CHAIN_IDS.mainnet).toBe(2741);
  });

  it('has correct testnet chain ID (11124)', () => {
    expect(ABSTRACT_CHAIN_IDS.testnet).toBe(11124);
  });

  it('has checksummed USDC addresses for both chains', () => {
    expect(ABSTRACT_USDC[2741]).toBe(getAddress(ABSTRACT_USDC[2741]));
    expect(ABSTRACT_USDC[11124]).toBe(getAddress(ABSTRACT_USDC[11124]));
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

describe('Abstract approved facilitators — fail closed on mainnet', () => {
  it('ships an empty mainnet approved list', () => {
    expect(ABSTRACT_APPROVED_FACILITATORS).toEqual([]);
    expect(getAbstractApprovedFacilitators(ABSTRACT_CHAIN_IDS.mainnet)).toEqual([]);
  });

  it('does not treat the Anvil/Hardhat default address as a mainnet facilitator', () => {
    expect(ABSTRACT_APPROVED_FACILITATORS).not.toContain(ABSTRACT_ANVIL_FACILITATOR);
    expect(() =>
      assertAbstractFacilitatorApproved(
        ABSTRACT_ANVIL_FACILITATOR,
        ABSTRACT_CHAIN_IDS.mainnet,
      ),
    ).toThrow(/fail closed/i);
  });

  it('rejects any mainnet facilitator until a verified address is configured', () => {
    expect(() =>
      assertAbstractFacilitatorApproved(UNAPPROVED, ABSTRACT_CHAIN_IDS.mainnet),
    ).toThrow(/No verified Abstract mainnet facilitator is configured/);
  });

  it('keeps the Anvil/Hardhat address on the testnet list only', () => {
    expect(ABSTRACT_TESTNET_APPROVED_FACILITATORS).toEqual([ABSTRACT_ANVIL_FACILITATOR]);
    expect(getAbstractApprovedFacilitators(ABSTRACT_CHAIN_IDS.testnet)).toEqual([
      ABSTRACT_ANVIL_FACILITATOR,
    ]);
    expect(() =>
      assertAbstractFacilitatorApproved(
        ABSTRACT_ANVIL_FACILITATOR,
        ABSTRACT_CHAIN_IDS.testnet,
      ),
    ).not.toThrow();
  });

  it('rejects an unapproved testnet facilitator', () => {
    expect(() =>
      assertAbstractFacilitatorApproved(UNAPPROVED, ABSTRACT_CHAIN_IDS.testnet),
    ).toThrow('not on the Abstract approved list');
  });
});

describe('AbstractDelegatedFacilitatorAdapter — instantiation', () => {
  it('creates adapter with the testnet approved facilitator', () => {
    const adapter = new AbstractDelegatedFacilitatorAdapter(
      createLocalWalletClient(),
      { facilitatorAddress: TESTNET_FACILITATOR },
      ABSTRACT_CHAIN_IDS.testnet,
    );
    expect(adapter).toBeDefined();
  });

  it('throws on mainnet when the official list is empty', () => {
    expect(() =>
      new AbstractDelegatedFacilitatorAdapter(
        createLocalWalletClient(),
        { facilitatorAddress: ABSTRACT_ANVIL_FACILITATOR },
        ABSTRACT_CHAIN_IDS.mainnet,
      ),
    ).toThrow(/No verified Abstract mainnet facilitator is configured/);
  });

  it('defaults to mainnet and fail-closes without a verified facilitator', () => {
    expect(() =>
      new AbstractDelegatedFacilitatorAdapter(
        createLocalWalletClient(),
        { facilitatorAddress: ABSTRACT_ANVIL_FACILITATOR },
      ),
    ).toThrow(/fail closed/i);
  });

  it('throws when a testnet facilitator is not approved and not in userAllowlist', () => {
    expect(() =>
      new AbstractDelegatedFacilitatorAdapter(
        createLocalWalletClient(),
        { facilitatorAddress: UNAPPROVED },
        ABSTRACT_CHAIN_IDS.testnet,
      ),
    ).toThrow('not on the Abstract approved list');
  });

  it('creates a mainnet adapter only with an explicit userAllowlist opt-in', () => {
    const adapter = new AbstractDelegatedFacilitatorAdapter(
      createLocalWalletClient(),
      {
        facilitatorAddress: UNAPPROVED,
        userAllowlist: [UNAPPROVED],
      },
      ABSTRACT_CHAIN_IDS.mainnet,
    );
    expect(adapter).toBeDefined();
  });
});

describe('AbstractDelegatedFacilitatorAdapter — permit signing', () => {
  let adapter: AbstractDelegatedFacilitatorAdapter;

  beforeEach(() => {
    adapter = new AbstractDelegatedFacilitatorAdapter(
      createLocalWalletClient(),
      { facilitatorAddress: TESTNET_FACILITATOR },
      ABSTRACT_CHAIN_IDS.testnet,
    );
  });

  it('signs a payment permit with EIP-712', async () => {
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(result.permitSignature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    expect(result.chainId).toBe(ABSTRACT_CHAIN_IDS.testnet);
  });

  it('permit includes correct fields', async () => {
    const result = await adapter.signPaymentPermit({
      amount: MOCK_AMOUNT,
      payTo: MOCK_MERCHANT,
      nonce: MOCK_NONCE,
      resource: MOCK_RESOURCE,
    });

    expect(result.permit.facilitator).toBe(TESTNET_FACILITATOR);
    expect(result.permit.token).toBe(ABSTRACT_USDC[ABSTRACT_CHAIN_IDS.testnet]);
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
    const customToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
    const customAdapter = new AbstractDelegatedFacilitatorAdapter(
      createLocalWalletClient(),
      {
        facilitatorAddress: TESTNET_FACILITATOR,
        token: customToken,
      },
      ABSTRACT_CHAIN_IDS.testnet,
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

describe('AbstractDelegatedFacilitatorAdapter — x402 payload', () => {
  let adapter: AbstractDelegatedFacilitatorAdapter;

  beforeEach(() => {
    adapter = new AbstractDelegatedFacilitatorAdapter(
      createLocalWalletClient(),
      { facilitatorAddress: TESTNET_FACILITATOR },
      ABSTRACT_CHAIN_IDS.testnet,
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
    expect(payload.chainId).toBe(ABSTRACT_CHAIN_IDS.testnet);
    expect(payload.facilitator).toBe(TESTNET_FACILITATOR);
    expect(payload.permitSignature).toMatch(/^0x[a-fA-F0-9]{130}$/);
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
