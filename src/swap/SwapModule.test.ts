import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseAbi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import { SwapModule, applySlippage, calcDeadline, calcProtocolFee } from './SwapModule.js';

const OWNER: Address = '0x1111111111111111111111111111111111111111';
const ACCOUNT: Address = '0x2222222222222222222222222222222222222222';
const TOKEN_IN: Address = '0x3333333333333333333333333333333333333333';
const TOKEN_OUT: Address = '0x4444444444444444444444444444444444444444';
const APPROVAL_HASH = `0x${'aa'.repeat(32)}` as Hash;
const SWAP_HASH = `0x${'bb'.repeat(32)}` as Hash;
const MAX_UINT256 = (1n << 256n) - 1n;

// Independent contract signatures keep the deadline assertion separate from the SDK ABI.
const ROUTER_ABI = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const TOKEN_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);

function harness(options: { accountAddress?: Address; feeBps?: number; allowance?: bigint } = {}) {
  let allowance = options.allowance ?? MAX_UINT256;
  const sent: { to: Address; data: Hex }[] = [];
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'allowance') return allowance;
    return [200_000n, 0n, 0, 100_000n];
  });
  const waitForTransactionReceipt = vi.fn(async () => {
    allowance = 100_000n;
    return { status: 'success' };
  });
  const sendTransaction = vi.fn(async (args: { to: Address; data: Hex }) => {
    sent.push(args);
    return args.to === TOKEN_IN ? APPROVAL_HASH : SWAP_HASH;
  });
  const module = new SwapModule(
    { readContract, waitForTransactionReceipt } as unknown as PublicClient,
    { account: { address: OWNER }, chain: { id: 8453 }, sendTransaction } as unknown as WalletClient,
    options.accountAddress ?? OWNER,
    { feeBps: options.feeBps ?? 0 },
  );
  return { module, sent, readContract, waitForTransactionReceipt, sendTransaction };
}

afterEach(() => vi.restoreAllMocks());

describe('swap execution safety', () => {
  it('rejects fee-bearing execution before any quote, approval, or fee transaction', async () => {
    const { module, sent, readContract } = harness({ feeBps: 875, allowance: 0n });
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n)).rejects.toThrow(/fee.*atomic/i);
    expect(sent).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects fee-bearing execution even when rounding would make its fee zero', async () => {
    const { module, sent } = harness({ feeBps: 875 });
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 1n)).rejects.toThrow(/fee.*atomic/i);
    expect(sent).toEqual([]);
  });

  it('rejects AgentAccount execution rather than spending from its operator EOA', async () => {
    const { module, sent, readContract } = harness({ accountAddress: ACCOUNT });
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n)).rejects.toThrow(/EOA.*accountAddress/i);
    expect(sent).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('puts the requested expiry in SwapRouter02 multicall calldata', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { module, sent } = harness();
    const result = await module.swap(TOKEN_IN, TOKEN_OUT, 100_000n, { deadlineSecs: 45, slippageBps: 100 });
    expect(result.txHash).toBe(SWAP_HASH);
    expect(result.feeTxHash).toBeUndefined();
    expect(sent).toHaveLength(1);
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: sent[0].data });
    expect(outer.functionName).toBe('multicall');
    const [deadline, calls] = outer.args as readonly [bigint, readonly Hex[]];
    expect(deadline).toBe(1_800_000_045n);
    expect(calls).toHaveLength(1);
    const inner = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] });
    expect(inner.functionName).toBe('exactInputSingle');
    expect(inner.args?.[0]).toMatchObject({ recipient: OWNER, amountIn: 100_000n, amountOutMinimum: 198_000n });
  });

  it('waits for a successful approval and checks effective allowance before submitting the trade', async () => {
    const { module, sent, waitForTransactionReceipt } = harness({ allowance: 0n });
    let confirm!: (receipt: { status: string }) => void;
    waitForTransactionReceipt.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const swap = module.swap(TOKEN_IN, TOKEN_OUT, 100_000n);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const approval = decodeFunctionData({ abi: TOKEN_ABI, data: sent[0].data });
    expect(approval.args?.[1]).toBe(100_000n);
    expect(sent[0].to).toBe(TOKEN_IN);
    confirm({ status: 'success' });
    // This approval did not change the allowance: a successful tx alone is insufficient.
    await expect(swap).rejects.toThrow(/allowance/i);
    expect(sent).toHaveLength(1);
  });

  it('allows a trade after the approval is confirmed and allowance covers the input', async () => {
    const { module, sent } = harness({ allowance: 0n });
    const result = await module.swap(TOKEN_IN, TOKEN_OUT, 100_000n);
    expect(result.approvalTxHash).toBe(APPROVAL_HASH);
    expect(result.approvalRequired).toBe(true);
    expect(sent).toHaveLength(2);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: sent[1].data }).functionName).toBe('multicall');
  });

  it('does not submit a trade after reverted approval', async () => {
    const { module, sent, waitForTransactionReceipt } = harness({ allowance: 0n });
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n)).rejects.toThrow(/approval.*revert/i);
    expect(sent).toHaveLength(1);
  });

  it('does not submit a trade when approval confirmation is unknown', async () => {
    const { module, sent, waitForTransactionReceipt } = harness({ allowance: 0n });
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('RPC timeout'));
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n)).rejects.toThrow('RPC timeout');
    expect(sent).toHaveLength(1);
  });

  it.each([0n, -1n, MAX_UINT256 + 1n])('rejects invalid input %s before RPC or signing', async (amount) => {
    const { module, sent, readContract } = harness();
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, amount)).rejects.toThrow(/amount/i);
    expect(sent).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([-1, 10_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid slippage %s before RPC or signing', async (slippageBps) => {
    const { module, sent, readContract } = harness();
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n, { slippageBps })).rejects.toThrow(/slippage/i);
    expect(sent).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('rejects invalid expiry %s before RPC or signing', async (deadlineSecs) => {
    const { module, sent, readContract } = harness();
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n, { deadlineSecs })).rejects.toThrow(/deadline/i);
    expect(sent).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects a quote with zero minimum output before approving', async () => {
    const { module, sent, readContract } = harness({ allowance: 0n });
    readContract.mockResolvedValue([1n, 0n, 0, 100_000n]);
    await expect(module.swap(TOKEN_IN, TOKEN_OUT, 100_000n, { slippageBps: 50 })).rejects.toThrow(/minimum output/i);
    expect(sent).toEqual([]);
  });
});

describe('swap arithmetic validation', () => {
  it.each([-1, 100_001, 1.5, Number.NaN])('rejects invalid protocol fee units %s', (feeBps) => {
    expect(() => calcProtocolFee(100_000n, feeBps)).toThrow(/fee/i);
  });
  it('validates helper inputs and preserves the existing fee denominator', () => {
    expect(calcProtocolFee(100_000n, 875)).toBe(875n);
    expect(() => applySlippage(1n, -1)).toThrow(/slippage/i);
    expect(() => calcDeadline(0)).toThrow(/deadline/i);
  });
});
