/**
 * Test helper: on-chain evidence for x402 settlement receipts.
 *
 * x402 counts a successful receipt as payment only when it carries the
 * phase transfer's ERC-20 Transfer(wallet → to, amount) (or that transfer's
 * own TransactionQueued entry). Tests record each submitted transfer by hash
 * and build receipts from the record, so they exercise the real classifier.
 */
import { vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
import { AgentAccountV2Abi } from '../../abi.js';
import { X402Client, x402SettlementReceiptIsQueued } from '../client.js';

const ERC20_TRANSFER_ABI = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}] as const;

export type EvidencedTransfer = { token: string; to: string; amount: bigint };

const lower = (a: string) => a.toLowerCase() as Address;

/** ERC-20 Transfer log emitted by `token`. */
export function transferLog(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: ERC20_TRANSFER_ABI, eventName: 'Transfer', args: { from: lower(from), to: lower(to) } }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}

/** AgentAccountV2 TransactionQueued log emitted by `wallet`. */
export function queuedLog(wallet: string, t: EvidencedTransfer, opts: { value?: bigint; txId?: bigint } = {}) {
  return {
    address: wallet,
    topics: encodeEventTopics({ abi: AgentAccountV2Abi, eventName: 'TransactionQueued', args: { txId: opts.txId ?? 1n, to: lower(t.to) } }) as `0x${string}`[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [opts.value ?? 0n, lower(t.token), t.amount],
    ),
  };
}

/** Ledger of submitted transfers keyed by transaction hash. */
export function createEvidence(walletAddress: string) {
  const byHash = new Map<string, EvidencedTransfer>();
  return {
    /** Record the transfer submitted under `hash`; returns `hash`. */
    record<H extends string>(hash: H, transfer: EvidencedTransfer): H {
      byHash.set(hash.toLowerCase(), transfer);
      return hash;
    },
    /** Logs proving the transfer recorded for `hash` (none if unrecorded). */
    logsFor(hash: string) {
      const t = byHash.get(String(hash).toLowerCase());
      return t ? [transferLog(t.token, walletAddress, t.to, t.amount)] : [];
    },
    /** A successful receipt carrying the recorded transfer's evidence. */
    paid(hash: string) {
      return { status: 'success' as const, logs: this.logsFor(hash) };
    },
  };
}

/**
 * For protocol state-machine tests that stub `executePayment` (so no transfer
 * exists): stub the client's receipt-evidence layer — a successful receipt is
 * `settled` unless the wallet emitted TransactionQueued. Real classification
 * is exercised by tests that submit through the transfer path.
 */
type ReceiptLike = Parameters<typeof x402SettlementReceiptIsQueued>[0];
type ClassifyHost = { classifyReceipt(receipt: ReceiptLike): string; wallet?: { address?: string } };

export function stubReceiptEvidence() {
  const proto = X402Client.prototype as unknown as ClassifyHost;
  return vi.spyOn(proto, 'classifyReceipt').mockImplementation(function (this: ClassifyHost, receipt: ReceiptLike) {
    return x402SettlementReceiptIsQueued(receipt, this.wallet?.address) ? 'queued' : 'settled';
  });
}
