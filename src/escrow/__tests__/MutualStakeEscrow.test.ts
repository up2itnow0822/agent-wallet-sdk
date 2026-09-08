/**
 * MutualStakeEscrow.create must return the vault that the factory actually
 * deployed. Re-calling createEscrow via eth_call after the transaction
 * cannot do that: a nonce/CREATE factory returns the *next* address, and a
 * CREATE2-same-salt factory reverts because the vault already exists.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { MutualStakeEscrow } from '../MutualStakeEscrow.js';

const BUYER = getAddress('0x1111111111111111111111111111111111111111');
const SELLER = getAddress('0x2222222222222222222222222222222222222222');
const FACTORY = getAddress('0x3333333333333333333333333333333333333333');
const TOKEN = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const VERIFIER = getAddress('0x4444444444444444444444444444444444444444');
const REAL_VAULT = getAddress('0x5555555555555555555555555555555555555555');
const PHANTOM_VAULT = getAddress('0x6666666666666666666666666666666666666666');
const TX_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;

const VaultCreatedEvent = {
  name: 'VaultCreated',
  type: 'event',
  inputs: [
    { name: 'vault', type: 'address', indexed: true },
    { name: 'buyer', type: 'address', indexed: true },
    { name: 'seller', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: false },
    { name: 'paymentAmount', type: 'uint256', indexed: false },
    { name: 'buyerStake', type: 'uint256', indexed: false },
    { name: 'sellerStake', type: 'uint256', indexed: false },
    { name: 'verifier', type: 'address', indexed: false },
    { name: 'deadline', type: 'uint256', indexed: false },
  ],
} as const;

function vaultCreatedLog(vault: Address) {
  const topics = encodeEventTopics({
    abi: [VaultCreatedEvent],
    eventName: 'VaultCreated',
    args: { vault, buyer: BUYER, seller: SELLER },
  });
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [TOKEN, 1_000_000n, 1_000_000n, 1_000_000n, VERIFIER, 1_800_000_000n]
  );
  return {
    address: FACTORY,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: TX_HASH,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function makeEscrow(opts: {
  writeContract: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
}) {
  return new MutualStakeEscrow({
    publicClient: {
      waitForTransactionReceipt: opts.waitForTransactionReceipt,
      readContract: opts.readContract,
    } as unknown as ConstructorParameters<typeof MutualStakeEscrow>[0]['publicClient'],
    walletClient: {
      account: { address: BUYER },
      chain: { id: 8453 },
      writeContract: opts.writeContract,
    } as unknown as ConstructorParameters<typeof MutualStakeEscrow>[0]['walletClient'],
    factoryAddress: FACTORY,
    chainId: 8453,
  });
}

const CREATE_PARAMS = {
  seller: SELLER,
  paymentAmount: 1_000_000n,
  buyerStake: 1_000_000n,
  sellerStake: 1_000_000n,
  verifier: VERIFIER,
  deadline: 1_800_000_000,
  challengeWindow: 86400,
  token: TOKEN,
};

describe('MutualStakeEscrow.create', () => {
  it('returns the vault from VaultCreated, not a post-tx createEscrow simulation', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      logs: [vaultCreatedLog(REAL_VAULT)],
    });
    const readContract = vi.fn().mockResolvedValue(PHANTOM_VAULT);

    const escrow = makeEscrow({
      writeContract,
      waitForTransactionReceipt,
      readContract,
    });

    const created = await escrow.create(CREATE_PARAMS);

    expect(created.txHash).toBe(TX_HASH);
    expect(created.address).toBe(REAL_VAULT);
    expect(created.address).not.toBe(PHANTOM_VAULT);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('fails closed when the receipt has no VaultCreated log', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ logs: [] });
    const readContract = vi.fn().mockResolvedValue(PHANTOM_VAULT);

    const escrow = makeEscrow({
      writeContract,
      waitForTransactionReceipt,
      readContract,
    });

    await expect(escrow.create(CREATE_PARAMS)).rejects.toThrow(/VaultCreated/);
    expect(readContract).not.toHaveBeenCalled();
  });
});
