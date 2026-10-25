import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hash, type PublicClient, type WalletClient } from 'viem';
import { MutualStakeEscrow } from './MutualStakeEscrow.js';
import type { CreateEscrowParams } from './types.js';

const BUYER: Address = '0x1111111111111111111111111111111111111111';
const SELLER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x3333333333333333333333333333333333333333';
const FACTORY: Address = '0x4444444444444444444444444444444444444444';
const VAULT: Address = '0x5555555555555555555555555555555555555555';
const NEXT_VAULT: Address = '0x6666666666666666666666666666666666666666';
const VERIFIER: Address = '0x7777777777777777777777777777777777777777';
const TX_HASH = `0x${'aa'.repeat(32)}` as Hash;
const EVENT_ABI = parseAbi([
  'event VaultCreated(address indexed vault,address indexed buyer,address indexed seller,address token,uint256 paymentAmount,uint256 buyerStake,uint256 sellerStake,address verifier,uint256 deadline)',
]);

const PARAMS: CreateEscrowParams = {
  seller: SELLER, token: TOKEN, paymentAmount: 100n, buyerStake: 10n, sellerStake: 20n,
  verifier: VERIFIER, deadline: 1_800_000_000, challengeWindow: 3600,
};

function event(overrides: Partial<{
  address: Address; vault: Address; buyer: Address; seller: Address; token: Address;
  paymentAmount: bigint; buyerStake: bigint; sellerStake: bigint; verifier: Address; deadline: bigint;
}> = {}) {
  const args = {
    vault: VAULT, buyer: BUYER, seller: SELLER, token: TOKEN,
    paymentAmount: PARAMS.paymentAmount, buyerStake: PARAMS.buyerStake, sellerStake: PARAMS.sellerStake,
    verifier: VERIFIER, deadline: BigInt(PARAMS.deadline), ...overrides,
  };
  return {
    address: overrides.address ?? FACTORY,
    topics: encodeEventTopics({ abi: EVENT_ABI, eventName: 'VaultCreated', args }),
    data: encodeAbiParameters(parseAbiParameters('address,uint256,uint256,uint256,address,uint256'), [
      args.token, args.paymentAmount, args.buyerStake, args.sellerStake, args.verifier, args.deadline,
    ]),
  };
}

function harness(logs = [event()], status = 'success') {
  const readContract = vi.fn(async () => NEXT_VAULT);
  const writeContract = vi.fn(async () => TX_HASH);
  const waitForTransactionReceipt = vi.fn(async () => ({ status, logs }));
  const escrow = new MutualStakeEscrow({
    publicClient: { readContract, waitForTransactionReceipt } as unknown as PublicClient,
    walletClient: { account: { address: BUYER }, writeContract, chain: { id: 8453 } } as unknown as WalletClient,
    factoryAddress: FACTORY,
    chainId: 8453,
  });
  return { escrow, readContract, writeContract, waitForTransactionReceipt };
}

describe('escrow creation receipt binding', () => {
  it('returns the vault emitted by the confirmed creation rather than a later simulated deployment', async () => {
    const { escrow, readContract } = harness();
    await expect(escrow.create(PARAMS)).resolves.toEqual({ address: VAULT, txHash: TX_HASH });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a reverted factory transaction even when logs claim creation', async () => {
    const { escrow, readContract } = harness([event()], 'reverted');
    await expect(escrow.create(PARAMS)).rejects.toThrow(/creation.*success|creation.*revert/i);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects missing creation evidence without resimulating a successful transaction', async () => {
    const { escrow, readContract } = harness([]);
    await expect(escrow.create(PARAMS)).rejects.toThrow(/VaultCreated/i);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([
    { address: NEXT_VAULT }, { buyer: SELLER }, { seller: BUYER }, { token: NEXT_VAULT },
    { paymentAmount: 99n }, { buyerStake: 9n }, { sellerStake: 19n }, { verifier: NEXT_VAULT },
    { deadline: BigInt(PARAMS.deadline) + 1n }, { vault: zeroAddress },
  ])('rejects creation evidence from a different factory or different terms: %s', async (overrides) => {
    const { escrow } = harness([event(overrides)]);
    await expect(escrow.create(PARAMS)).rejects.toThrow(/VaultCreated/i);
  });

  it('ignores unrelated factory logs and uses exactly one matching event', async () => {
    const { escrow } = harness([event({ address: NEXT_VAULT }), event({ seller: BUYER }), event()]);
    await expect(escrow.create(PARAMS)).resolves.toEqual({ address: VAULT, txHash: TX_HASH });
  });

  it('rejects ambiguous matching creation events', async () => {
    const { escrow } = harness([event(), event({ vault: NEXT_VAULT })]);
    await expect(escrow.create(PARAMS)).rejects.toThrow(/VaultCreated/i);
  });

  it('binds receipt validation to the arguments signed at call time', async () => {
    const { escrow, waitForTransactionReceipt } = harness();
    const params = { ...PARAMS };
    waitForTransactionReceipt.mockImplementationOnce(async () => {
      params.seller = BUYER;
      params.paymentAmount = 99n;
      return { status: 'success', logs: [event()] };
    });
    await expect(escrow.create(params)).resolves.toEqual({ address: VAULT, txHash: TX_HASH });
  });
});
