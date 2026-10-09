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

function errorTxHash(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    if ('txHash' in error && isEvmTxHash(error.txHash)) {
      return error.txHash;
    }
  }
  const match = errorMessage(error).match(/0x[0-9a-fA-F]{64}/);
  return match?.[0];
}

function uniqueValidHashes(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const value of values) {
    if (!isEvmTxHash(value) || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    hashes.push(value);
  }
  return hashes;
}

function collectInputHashes(input: ClassifySpendAttemptInput, error?: unknown): string[] {
  const extras = input.txHashes ? Array.from(input.txHashes) : [];
  return uniqueValidHashes([
    input.txHash,
    input.receipt?.transactionHash,
    input.receipt?.txHash,
    errorTxHash(error ?? input.error),
    ...extras,
  ]);
}

function toBigInt(value: bigint | number | string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
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
  };
}

const PRE_BROADCAST_DEFINITE = new Set([
  'X402BudgetExceededError',
  'X402PaymentError',
  'X402SettlementBacklogError',
]);

const POST_BROADCAST_UNKNOWN = new Set([
  'X402SettlementUnknownError',
  'X402SettlementQueuedError',
]);

const UNKNOWN_MESSAGE = /timed out|timeout|receipt polling|outcome unknown|not yet observed|replaced by a different transaction|ECONNRESET|ETIMEDOUT|network error/i;

/**
 * Classify a thrown spend error.
 *
 * Pre-broadcast failures and confirmed reverts are definite not-charged
 * (`released`, retrySafe unless the same idempotency key must not be reused).
 * Post-broadcast timeouts, queued owner-approval, and unclear receipts are
 * `hold-unknown` and never retry-safe.
 */
export function classifySpendError(error: unknown): SpendOutcome {
  const name = errorName(error);
  const txHash = errorTxHash(error);
  const txHashes = txHash ? [txHash] : [];

  if (name === 'X402SettlementRevertedError') {
    return outcome('released', {
      retrySafe: true,
      txHashes,
      txHash,
      reason: errorMessage(error) || 'settlement reverted',
    });
  }

  if (name === 'X402IntentTermsConflictError') {
    return outcome('released', {
      retrySafe: false,
      txHashes,
      reason: errorMessage(error) || 'idempotency key reused with different terms',
    });
  }

  if (PRE_BROADCAST_DEFINITE.has(name)) {
    return outcome('released', {
      retrySafe: true,
      txHashes,
      reason: errorMessage(error) || 'spend rejected before broadcast',
    });
  }

  if (POST_BROADCAST_UNKNOWN.has(name) || UNKNOWN_MESSAGE.test(errorMessage(error))) {
    return outcome('hold-unknown', {
      retrySafe: false,
      txHashes,
      txHash,
      reason: errorMessage(error) || 'settlement outcome unknown',
    });
  }

  return outcome('released', {
    retrySafe: true,
    txHashes,
    txHash,
    reason: errorMessage(error) || 'definite pre-broadcast failure',
  });
}

/**
 * Classify a spend attempt after execute.
 *
 * A result is `settled` only with a successful receipt and every required
 * EVM tx hash (`0x` + 64 hex). Invalid hashes never settle. Missing
 * confirmation after a hash is returned stays `hold-unknown`.
 */
export function classifySpendAttempt(input: ClassifySpendAttemptInput): SpendOutcome {
  const hashes = collectInputHashes(input);
  const amount = toBigInt(input.amount);
  const fee = toBigInt(input.fee);
  const base = {
    chainId: input.chainId,
    amount,
    fee,
    idempotencyKey: input.idempotencyKey,
  };

  if (input.error !== undefined && input.error !== null) {
    const classified = classifySpendError(input.error);
    return {
      ...classified,
      ...base,
      txHashes: uniqueValidHashes([...classified.txHashes, ...hashes]),
      txHash: classified.txHash ?? hashes[0],
      idempotencyKey: input.idempotencyKey ?? classified.idempotencyKey,
    };
  }

  const status = receiptStatus(input.receipt);
  if (status === 'reverted') {
    return outcome('released', {
      ...base,
      retrySafe: true,
      txHashes: hashes,
      reason: 'transaction reverted on-chain',
    });
  }

  const required = [
    input.txHash,
    input.receipt?.transactionHash,
    input.receipt?.txHash,
    ...(input.txHashes ? Array.from(input.txHashes) : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const requiredValid = required.length > 0 && required.every((value) => isEvmTxHash(value));

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

  return outcome('released', {
    ...base,
    retrySafe: true,
    txHashes: [],
    reason: 'no broadcast evidence',
  });
}
