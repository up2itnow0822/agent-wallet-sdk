/**
 * Spend-attempt outcomes for the reserve → execute → settle | release | hold-unknown flow.
 *
 * Callers (agentpay-mcp, ClawPowers) classify a spend after execute, then:
 *   - settled: valid receipt + required tx hash(es) → commit the reservation
 *   - released: definite not-charged → release and retry
 *   - hold-unknown: broadcast may have happened → keep the hold, lock the
 *     intent, do not auto-retry, reconcile on-chain. A timer never unlocks.
 */

const EVM_TX_HASH = /^0[xX][0-9a-fA-F]{64}$/;

export type SpendOutcomeStatus = 'settled' | 'released' | 'hold-unknown';

export interface SpendOutcome {
  status: SpendOutcomeStatus;
  txHashes: string[];
  txHash?: string;
  chainId?: number;
  amount?: bigint;
  fee?: bigint;
  retrySafe: boolean;
  idempotencyKey?: string;
  reason?: string;
  /**
   * True when the attempt reported a transaction identifier that is not a
   * valid EVM hash, so `txHashes` does not cover every submitted phase. Such
   * evidence can prove payment but never non-payment: a lock built from it is
   * never released by reconciliation.
   */
  incompleteEvidence?: true;
}

export interface SpendReceiptLike {
  status?: string | number;
  transactionHash?: string;
  txHash?: string;
}

export interface ClassifySpendAttemptInput {
  receipt?: SpendReceiptLike;
  error?: unknown;
  txHash?: string;
  txHashes?: Iterable<string | undefined | null>;
  chainId?: number;
  amount?: bigint | number | string;
  fee?: bigint | number | string;
  idempotencyKey?: string;
}

export function isEvmTxHash(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && EVM_TX_HASH.test(value);
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

function errorFields(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' ? error as Record<string, unknown> : {};
}

function errorReceipt(error: unknown): SpendReceiptLike | undefined {
  const receipt = errorFields(error).receipt;
  return receipt && typeof receipt === 'object' ? receipt as SpendReceiptLike : undefined;
}

function errorHashCandidates(error: unknown): unknown[] {
  const fields = errorFields(error);
  const receipt = errorReceipt(error);
  return [
    fields.txHash,
    fields.transactionHash,
    receipt?.transactionHash,
    receipt?.txHash,
    fields.confirmedFeeTxHash,
    fields.feeTxHash,
    ...(Array.isArray(fields.txHashes) ? fields.txHashes : []),
    ...(errorMessage(error).match(/0[xX][0-9a-fA-F]{64}/g) ?? []),
  ];
}

function uniqueValidHashes(values: unknown[]): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const value of values) {
    if (!isEvmTxHash(value) || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    hashes.push(value);
  }
  return hashes;
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function errorMetadata(error: unknown): Pick<SpendOutcome, 'chainId' | 'amount' | 'fee' | 'idempotencyKey'> {
  const fields = errorFields(error);
  return {
    chainId: typeof fields.chainId === 'number' ? fields.chainId : undefined,
    amount: toBigInt(fields.amount),
    fee: toBigInt(fields.fee),
    idempotencyKey: typeof fields.idempotencyKey === 'string' ? fields.idempotencyKey : undefined,
  };
}

function receiptStatus(receipt?: SpendReceiptLike): 'success' | 'reverted' | 'unknown' {
  if (!receipt || receipt.status === undefined) return 'unknown';
  const status = receipt.status;
  if (status === 'success' || status === 'successful' || status === 1 || status === '0x1') {
    return 'success';
  }
  if (status === 'reverted' || status === 0 || status === '0x0' || status === 'failure') {
    return 'reverted';
  }
  return 'unknown';
}

/**
 * A confirmed on-chain revert with a single valid hash and no charged fee
 * is definite not-charged. `AgentExecutionError` with `executionStatus:
 * "reverted"` is the same evidence as `X402SettlementRevertedError`.
 */
function isConfirmedUnchargedRevert(
  error: unknown,
  requiredValid: boolean,
  hashCount: number,
  hasConfirmedFee = isEvmTxHash(errorFields(error).confirmedFeeTxHash),
): boolean {
  if (hasConfirmedFee || !requiredValid || hashCount !== 1) return false;
  const name = errorName(error);
  if (name === 'X402SettlementRevertedError') return true;
  return name === 'AgentExecutionError' && errorFields(error).executionStatus === 'reverted';
}

function outcome(
  status: SpendOutcomeStatus,
  extras: Partial<SpendOutcome> & { retrySafe: boolean },
): SpendOutcome {
  const txHashes = extras.txHashes ?? [];
  return {
    status,
    txHashes,
    txHash: extras.txHash ?? txHashes[0],
    chainId: extras.chainId,
    amount: extras.amount,
    fee: extras.fee,
    retrySafe: extras.retrySafe,
    idempotencyKey: extras.idempotencyKey,
    reason: extras.reason,
    ...(extras.incompleteEvidence ? { incompleteEvidence: true as const } : {}),
  };
}

/** Some reported identifier is not a valid hash (see SpendOutcome.incompleteEvidence). */
function droppedHash(required: unknown[]): true | undefined {
  return required.some((value) => !isEvmTxHash(value)) ? true : undefined;
}

const PRE_BROADCAST_DEFINITE = new Set([
  'X402BudgetExceededError',
  'X402PaymentError',
  'X402SettlementBacklogError',
]);

/**
 * Classify a thrown spend error.
 *
 * Pre-broadcast failures and confirmed reverts are definite not-charged
 * (`released`, retrySafe unless the same idempotency key must not be reused).
 * A known pre-broadcast error releases only without broadcast evidence.
 * Generic throws, timeouts, queued approval, and unclear receipts stay
 * `hold-unknown` and never retry-safe. A paid HTTP error can settle only with
 * explicit confirmation; a confirmed protocol fee prevents full release
 * when only the payee failed.
 */
export function classifySpendError(error: unknown): SpendOutcome {
  const name = errorName(error);
  const candidates = errorHashCandidates(error);
  const txHashes = uniqueValidHashes(candidates);
  const txHash = txHashes[0];
  const metadata = errorMetadata(error);
  const required = candidates.filter((value) => value !== undefined && value !== null && value !== '');
  const requiredValid = required.length > 0 && required.every(isEvmTxHash);

  if (name === 'X402PaidRequestError') {
    const classified = classifySpendAttempt({
      ...metadata,
      receipt: errorReceipt(error),
      txHashes: candidates as Array<string | undefined | null>,
    });
    return { ...classified, reason: errorMessage(error) || classified.reason };
  }

  if (isConfirmedUnchargedRevert(error, requiredValid, txHashes.length)) {
    return outcome('released', {
      ...metadata,
      retrySafe: true,
      txHashes,
      txHash,
      reason: errorMessage(error) || 'settlement reverted',
    });
  }

  if (required.length > 0) {
    return outcome('hold-unknown', {
      ...metadata,
      retrySafe: false,
      txHashes,
      incompleteEvidence: droppedHash(required),
      reason: errorMessage(error) || 'broadcast evidence without complete settlement confirmation',
    });
  }

  if (name === 'X402IntentTermsConflictError') {
    return outcome('released', {
      ...metadata,
      retrySafe: false,
      txHashes,
      reason: errorMessage(error) || 'idempotency key reused with different terms',
    });
  }

  if (PRE_BROADCAST_DEFINITE.has(name)) {
    return outcome('released', {
      ...metadata,
      retrySafe: true,
      txHashes,
      reason: errorMessage(error) || 'spend rejected before broadcast',
    });
  }

  return outcome('hold-unknown', {
    ...metadata,
    retrySafe: false,
    txHashes,
    txHash,
    reason: errorMessage(error) || 'settlement outcome unknown',
  });
}

/**
 * Classify a spend attempt after execute.
 *
 * A result is `settled` only with a successful receipt and every required
 * EVM tx hash (`0x` + 64 hex). Invalid hashes never settle. Missing
 * confirmation after a hash is returned stays `hold-unknown`. A revert must
 * identify one valid reverted transaction; other charged or unresolved legs
 * keep the full hold until explicitly reconciled.
 * A queued error takes precedence over its outer receipt: a successful
 * authorization transaction does not prove that the transfer executed.
 * Classify a later verified execution receipt separately from that error.
 */
export function classifySpendAttempt(input: ClassifySpendAttemptInput): SpendOutcome {
  const { receipt, candidates } = attemptEvidence(input);
  const result = classifyAttempt(input, receipt, candidates);
  // A held outcome whose evidence dropped a malformed identifier says so, so
  // its lock can never be released from the remaining hashes alone.
  const { incompleteEvidence: _dropped, ...rest } = result;
  const required = candidates.filter((value) => value !== undefined && value !== null && value !== '');
  return result.status === 'hold-unknown' && droppedHash(required) ? { ...rest, incompleteEvidence: true } : rest;
}

function attemptEvidence(input: ClassifySpendAttemptInput): { receipt: SpendReceiptLike | undefined; candidates: unknown[] } {
  const receipt = input.receipt ??
    (errorName(input.error) === 'X402PaidRequestError' ? errorReceipt(input.error) : undefined);
  const candidates = [
    input.txHash,
    receipt?.transactionHash,
    receipt?.txHash,
    ...(input.txHashes ? Array.from(input.txHashes) : []),
    ...errorHashCandidates(input.error),
  ];
  return { receipt, candidates };
}

function classifyAttempt(
  input: ClassifySpendAttemptInput,
  receipt: SpendReceiptLike | undefined,
  candidates: unknown[],
): SpendOutcome {
  const hashes = uniqueValidHashes(candidates);
  const metadata = errorMetadata(input.error);
  const amount = toBigInt(input.amount ?? metadata.amount);
  const fee = toBigInt(input.fee ?? metadata.fee);
  const base = {
    chainId: input.chainId ?? metadata.chainId,
    amount,
    fee,
    idempotencyKey: input.idempotencyKey ?? metadata.idempotencyKey,
  };

  if (errorName(input.error) === 'X402SettlementQueuedError') {
    return outcome('hold-unknown', {
      ...base,
      retrySafe: false,
      txHashes: hashes,
      reason: errorMessage(input.error) || 'queued authorization has not executed the transfer',
    });
  }

  const status = receiptStatus(receipt);
  const hasConfirmedFee = isEvmTxHash(errorFields(input.error).confirmedFeeTxHash);
  const required = candidates.filter((value) => value !== undefined && value !== null && value !== '');
  const requiredValid = required.length > 0 && required.every(isEvmTxHash);
  if (status === 'reverted') {
    if (hasConfirmedFee || !requiredValid || hashes.length !== 1) {
      return outcome('hold-unknown', {
        ...base,
        retrySafe: false,
        txHashes: hashes,
        reason: 'revert receipt does not confirm every required transaction is uncharged',
      });
    }
    return outcome('released', {
      ...base,
      retrySafe: true,
      txHashes: hashes,
      reason: 'transaction reverted on-chain',
    });
  }

  if (status === 'success') {
    if (requiredValid && hashes.length > 0) {
      return outcome('settled', {
        ...base,
        retrySafe: false,
        txHashes: hashes,
        reason: 'receipt confirmed with valid transaction hash',
      });
    }
    return outcome('hold-unknown', {
      ...base,
      retrySafe: false,
      txHashes: hashes,
      reason: 'receipt claimed success without a valid EVM transaction hash',
    });
  }

  if (input.error !== undefined && input.error !== null) {
    const classified = classifySpendError(input.error);
    const definiteRevert = isConfirmedUnchargedRevert(
      input.error, requiredValid, hashes.length, hasConfirmedFee,
    );
    const mustHold = classified.status === 'released' && required.length > 0 && !definiteRevert;
    return {
      ...classified,
      ...base,
      status: mustHold ? 'hold-unknown' : classified.status,
      retrySafe: mustHold ? false : classified.retrySafe,
      reason: mustHold ? 'broadcast evidence without complete settlement confirmation' : classified.reason,
      txHashes: hashes,
      txHash: hashes[0],
      idempotencyKey: input.idempotencyKey ?? classified.idempotencyKey,
    };
  }

  if (hashes.length > 0) {
    return outcome('hold-unknown', {
      ...base,
      retrySafe: false,
      txHashes: hashes,
      reason: 'transaction hash returned but settlement is unconfirmed',
    });
  }

  if (required.length > 0 && !requiredValid) {
    return outcome('hold-unknown', {
      ...base,
      retrySafe: false,
      txHashes: [],
      reason: 'transaction hash is not a valid EVM hash',
    });
  }

  return outcome('hold-unknown', {
    ...base,
    retrySafe: false,
    txHashes: [],
    reason: 'settlement is unconfirmed; no definite pre-broadcast failure',
  });
}
