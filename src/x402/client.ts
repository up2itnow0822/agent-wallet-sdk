/**
 * @module x402/client
 * x402 Payment Client — automatic HTTP 402 payment handling for AgentWallet.
 *
 * Wraps the standard fetch API to transparently handle 402 Payment Required
 * responses using the x402 protocol. Supports multi-chain, multi-asset payments
 * (USDC, USDT, DAI, WETH, and any token in the TokenRegistry) across all 11
 * mainnet chains configured in x402/types.ts.
 *
 * Flow: fetch → 402 detected → parse payment requirements → resolve asset address
 *       via TokenRegistry → budget check → execute ERC-20 transfer → retry with
 *       X-PAYMENT header.
 */
// x402 Client — automatic 402 payment handling for AgentWallet (v6: multi-asset)
import type { Address, Hash } from 'viem';
import type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402ClientConfig,
  X402TransactionLog,
} from './types.js';
import { DEFAULT_SUPPORTED_NETWORKS } from './types.js';
import { X402BudgetTracker } from './budget.js';
import { agentTransferToken, checkBudget } from '../index.js';
import { resolveAssetAddress } from './multi-asset.js';

const MAX_PAYMENT_REQUIRED_HEADER_BYTES = 64 * 1024;

/** Max completed settlements retained for retry replay. In-flight entries are never evicted. */
export const X402_SETTLEMENT_CACHE_LIMIT = 256;
/** Window during which a successful settlement may be replayed for the same intent. */
export const X402_SETTLEMENT_RETRY_WINDOW_MS = 120_000;

type CachedSettlement = {
  promise: Promise<{ txHash: Hash }>;
  /** null while the settlement is in flight; otherwise epoch ms when the retry window ends. */
  expiresAt: number | null;
};

/** Internal: onBeforePayment returned false. Waiters must observe skip, not a second transfer. */
const X402_POLICY_SKIP = Symbol('x402-policy-skip');

/**
 * [MAX-ADDED] x402 Payment Client for AgentWallet.
 *
 * Handles the full x402 payment flow:
 * 1. Detects 402 Payment Required responses
 * 2. Parses payment instructions from PAYMENT-REQUIRED header
 * 3. Validates against budget controls
 * 4. Executes USDC payment via AgentWallet contract
 * 5. Retries original request with payment proof
 */
export function explicitX402PaymentIntentId(
  req: X402PaymentRequirements,
): string | null {
  const extra = req.extra ?? {};
  if (typeof extra.idempotencyKey === 'string' && extra.idempotencyKey.trim() !== '') {
    return extra.idempotencyKey;
  }
  if (typeof extra.nonce === 'string' && extra.nonce.trim() !== '') {
    return extra.nonce;
  }
  return null;
}

export function canonicalizeX402RequestUrl(url: string | URL): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url);
  }
}

export function canonicalizeX402Amount(amount: string): string {
  if (!/^\d+$/.test(amount)) {
    return amount;
  }
  try {
    return BigInt(amount).toString();
  } catch {
    return amount;
  }
}

export function canonicalizeX402Asset(asset: string, network: string): string {
  return (resolveAssetAddress(asset, network) ?? asset).toLowerCase();
}

export function buildX402PaymentIdempotencyKey(
  method: string,
  url: string | URL,
  req: X402PaymentRequirements,
  uniqueFallback?: string,
): string {
  const extraKey = explicitX402PaymentIntentId(req) ?? uniqueFallback ?? '';
  const normalizedMethod = method.trim().toUpperCase() || 'GET';
  return [
    normalizedMethod,
    canonicalizeX402RequestUrl(url),
    req.network,
    canonicalizeX402Asset(req.asset, req.network),
    canonicalizeX402Amount(req.amount),
    req.payTo.toLowerCase(),
    req.scheme,
    extraKey,
  ].join('|');
}

export class X402Client {
  private wallet: any; // ReturnType<typeof createWallet> — avoid circular import
  private config: X402ClientConfig;
  private budget: X402BudgetTracker;
  private supportedNetworks: Set<string>;
  private paymentSettlements = new Map<string, CachedSettlement>();

  constructor(wallet: any, config: X402ClientConfig = {}) {
    this.wallet = wallet;
    this.config = {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: [...DEFAULT_SUPPORTED_NETWORKS],
      ...config,
    };
    this.budget = new X402BudgetTracker(config);
    this.supportedNetworks = new Set(this.config.supportedNetworks);
  }

  /**
   * Make an x402-aware fetch request. Automatically handles 402 responses.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = canonicalizeX402RequestUrl(url);
    const response = await globalThis.fetch(url, init);

    if (response.status !== 402) {
      return response;
    }

    if (!this.config.autoPay) {
      return response;
    }

    // Parse the 402 response
    const paymentRequired = await this.parse402Response(response);
    if (!paymentRequired) {
      return response; // Couldn't parse — return original 402
    }

    if (!this.isResourceBoundToRequest(paymentRequired, urlStr)) {
      return response;
    }

    // Find a compatible payment option
    const selected = this.selectPaymentOption(paymentRequired.accepts);
    if (!selected) {
      return response; // No compatible payment option
    }

    const amount = BigInt(selected.amount);
    const service = new URL(urlStr).hostname;
    const method = typeof init?.method === 'string' && init.method.trim() !== ''
      ? init.method
      : 'GET';
    const explicitIntent = explicitX402PaymentIntentId(selected);
    const idempotencyKey = buildX402PaymentIdempotencyKey(
      method,
      urlStr,
      selected,
      explicitIntent ?? crypto.randomUUID(),
    );
    const ensurePolicyAllowsPayment = async (): Promise<boolean> => {
      const budgetCheck = this.budget.checkBudget(service, amount);
      if (!budgetCheck.allowed) {
        throw new X402BudgetExceededError(budgetCheck.reason!, urlStr, selected);
      }
      if (this.config.onBeforePayment) {
        return this.config.onBeforePayment(selected, urlStr);
      }
      return true;
    };

    const paymentResult = explicitIntent
      ? await this.settlePayment(
          idempotencyKey,
          () => this.executePayment(selected),
          ensurePolicyAllowsPayment,
        )
      : (await ensurePolicyAllowsPayment()
          ? { ...(await this.executePayment(selected)), replayed: false as const }
          : null);
    if (!paymentResult) {
      return response;
    }
    const replayed = paymentResult.replayed;

    const paymentPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
      payload: {
        txHash: paymentResult.txHash,
        network: selected.network,
        idempotencyKey,
        replayed,
      },
    };

    const log: X402TransactionLog = {
      timestamp: Math.floor(Date.now() / 1000),
      service,
      url: urlStr,
      amount,
      token: selected.asset as Address,
      recipient: selected.payTo as Address,
      txHash: paymentResult.txHash,
      network: selected.network,
      scheme: selected.scheme,
      success: true,
      idempotencyKey,
      replayed,
    };
    this.budget.recordPayment(log);
    this.config.onPaymentComplete?.(log);

    // Retry request with payment proof
    const retryHeaders = new Headers(init?.headers);
    const payloadB64 = btoa(JSON.stringify(paymentPayload));
    retryHeaders.set('X-PAYMENT', payloadB64);

    const retryResponse = await globalThis.fetch(url, {
      ...init,
      headers: retryHeaders,
    });

    return retryResponse;
  }

  private pruneSettlements(now = Date.now()): void {
    const completed: string[] = [];
    for (const [key, entry] of this.paymentSettlements) {
      if (entry.expiresAt === null) {
        continue;
      }
      if (entry.expiresAt <= now) {
        this.paymentSettlements.delete(key);
        continue;
      }
      completed.push(key);
    }
    const overflow = completed.length - X402_SETTLEMENT_CACHE_LIMIT;
    if (overflow <= 0) {
      return;
    }
    for (let i = 0; i < overflow; i++) {
      this.paymentSettlements.delete(completed[i]);
    }
  }

  private async settlePayment(
    key: string,
    execute: () => Promise<{ txHash: Hash }>,
    beforeFreshTransfer?: () => Promise<boolean>,
  ): Promise<{ txHash: Hash; replayed: boolean } | null> {
    this.pruneSettlements();
    const existing = this.paymentSettlements.get(key);
    if (existing) {
      return this.observeSettledPayment(existing.promise, true);
    }

    // Reserve the in-flight slot before any await so concurrent retries share
    // one onBeforePayment and cannot start a second fee+payee transfer.
    const pending = (async () => {
      try {
        if (beforeFreshTransfer) {
          const proceed = await beforeFreshTransfer();
          if (!proceed) {
            throw X402_POLICY_SKIP;
          }
        }
        const result = await execute();
        try {
          await this.waitForSettlementReceipt(result.txHash);
        } catch (receiptError) {
          // Broadcast already happened. Evict only a confirmed revert so a
          // later retry can transfer again. RPC timeouts and missing receipts
          // stay in-flight and reuse this hash instead of paying twice.
          if (!(receiptError instanceof X402SettlementRevertedError)) {
            return result;
          }
          throw receiptError;
        }
        const entry = this.paymentSettlements.get(key);
        if (entry) {
          entry.expiresAt = Date.now() + X402_SETTLEMENT_RETRY_WINDOW_MS;
        }
        this.pruneSettlements();
        return result;
      } catch (error) {
        this.paymentSettlements.delete(key);
        throw error;
      }
    })();
    this.paymentSettlements.set(key, { promise: pending, expiresAt: null });
    return this.observeSettledPayment(pending, false);
  }

  private async observeSettledPayment(
    pending: Promise<{ txHash: Hash }>,
    replayed: boolean,
  ): Promise<{ txHash: Hash; replayed: boolean } | null> {
    try {
      const settled = await pending;
      return { txHash: settled.txHash, replayed };
    } catch (error) {
      if (error === X402_POLICY_SKIP) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A submitted hash is not a completed settlement. Keep the cache entry
   * in-flight (expiresAt = null) until the receipt is final so a later retry
   * cannot broadcast a second fee+payee transfer.
   */
  private async waitForSettlementReceipt(txHash: Hash): Promise<void> {
    const publicClient = this.wallet?.publicClient;
    const wait = publicClient?.waitForTransactionReceipt;
    if (typeof wait !== 'function') {
      throw new Error(
        'x402 settlement cannot be confirmed: wallet publicClient.waitForTransactionReceipt is missing',
      );
    }
    const receipt = await wait.call(publicClient, { hash: txHash });
    if (receipt?.status === 'reverted') {
      throw new X402SettlementRevertedError(txHash);
    }
    if (!receipt) {
      throw new Error(`x402 settlement receipt missing (${txHash})`);
    }
  }

  /**
   * Parse a 402 response to extract payment requirements.
   */
  async parse402Response(response: Response): Promise<X402PaymentRequired | null> {
    // Try PAYMENT-REQUIRED header first (standard x402)
    const headerValue = response.headers.get('payment-required')
      ?? response.headers.get('x-payment-required');

    if (headerValue) {
      try {
        if (headerValue.length > MAX_PAYMENT_REQUIRED_HEADER_BYTES) return null;
        const decoded = JSON.parse(atob(headerValue));
        if (this.isValidPaymentRequired(decoded)) return decoded as X402PaymentRequired;
      } catch {
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback
    try {
      const body = await response.clone().json();
      if (this.isValidPaymentRequired(body)) {
        return body as X402PaymentRequired;
      }
    } catch {
      // Not parseable
    }

    return null;
  }

  /**
   * Validate basic x402 shape before any payment selection.
   * Rejects malformed header/body payloads so untrusted 402 responses cannot
   * smuggle incomplete payment instructions into the wallet flow.
   */
  private isValidPaymentRequired(value: unknown): value is X402PaymentRequired {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as X402PaymentRequired;
    if (candidate.x402Version !== 1) return false;
    if (!candidate.resource || typeof candidate.resource.url !== 'string') return false;
    if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) return false;

    return candidate.accepts.every(req => (
      req
      && typeof req.scheme === 'string'
      && typeof req.network === 'string'
      && typeof req.asset === 'string'
      && typeof req.amount === 'string'
      && /^\d+$/.test(req.amount)
      && typeof req.payTo === 'string'
      && typeof req.maxTimeoutSeconds === 'number'
      && req.maxTimeoutSeconds > 0
      && req.maxTimeoutSeconds <= 300
    ));
  }

  /**
   * Bind the 402 payment demand to the exact request origin/path.
   * Allows relative resource URLs from the challenged server, but rejects
   * cross-origin or cross-path demands that could redirect payment to another
   * resource after a malicious/intercepted 402 response.
   */
  private isResourceBoundToRequest(paymentRequired: X402PaymentRequired, requestUrl: string): boolean {
    try {
      const requested = new URL(requestUrl);
      const resource = new URL(paymentRequired.resource.url, requested.origin);
      return resource.origin === requested.origin && resource.pathname === requested.pathname;
    } catch {
      return false;
    }
  }

  /**
   * Select the best compatible payment option from offered requirements.
   * Prefers: Base network, stablecoins, exact scheme.
   *
   * v6 change: resolves assets via TokenRegistry in addition to USDC_ADDRESSES.
   * Now accepts any ERC-20 whose address is in the TokenRegistry for the network.
   */
  selectPaymentOption(accepts: X402PaymentRequirements[]): X402PaymentRequirements | null {
    // Filter to supported networks and resolvable assets
    const compatible = accepts.filter(req => {
      if (!this.supportedNetworks.has(req.network)) return false;

      // Config override: explicit supportedAssets list
      if (this.config.supportedAssets?.[req.network]) {
        return this.config.supportedAssets[req.network].some(
          a => a.toLowerCase() === req.asset.toLowerCase()
        );
      }

      // v6: resolve via TokenRegistry — accept any known ERC-20 on this network
      const resolved = resolveAssetAddress(req.asset, req.network);
      return resolved != null;
    });

    if (compatible.length === 0) return null;

    // Prefer "exact" scheme, then lowest amount
    const exact = compatible.filter(r => r.scheme === 'exact');
    const candidates = exact.length > 0 ? exact : compatible;
    candidates.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)));

    return candidates[0];
  }

  /**
   * Execute the payment via AgentWallet's agentTransferToken.
   *
   * v6 change: resolves asset address via TokenRegistry before executing.
   * The 402 response may specify an asset by symbol ("USDC") or by address.
   */
  private async executePayment(req: X402PaymentRequirements): Promise<{ txHash: Hash }> {
    // Resolve the actual contract address for the requested asset
    const resolvedAddress = resolveAssetAddress(req.asset, req.network);
    if (!resolvedAddress) {
      throw new X402PaymentError(
        `Cannot resolve asset "${req.asset}" on network "${req.network}" to a contract address`,
        req
      );
    }

    // First check on-chain budget
    const onChainBudget = await checkBudget(this.wallet, resolvedAddress);
    const amount = BigInt(req.amount);

    if (amount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req
      );
    }

    if (amount > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req
      );
    }

    // Calculate and transfer protocol fee (0.77% = 77 bps)
    const X402_PROTOCOL_FEE_BPS = 77n;
    const FEE_COLLECTOR: Address = '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD';
    const feeAmount = (amount * X402_PROTOCOL_FEE_BPS) / 10000n;

    if (feeAmount > 0n) {
      await agentTransferToken(this.wallet, {
        token: req.asset as Address,
        to: FEE_COLLECTOR,
        amount: feeAmount,
      });
    }

    // Execute the ERC20 transfer via AgentWallet (full amount to payee)
    const txHash = await agentTransferToken(this.wallet, {
      token: resolvedAddress,
      to: req.payTo as Address,
      amount,
    });

    return { txHash };
  }

  // ─── Budget Access ───

  /** Get the budget tracker for direct inspection */
  get budgetTracker(): X402BudgetTracker {
    return this.budget;
  }

  /** Get transaction log */
  getTransactionLog(filter?: { service?: string; since?: number }): X402TransactionLog[] {
    return this.budget.getTransactionLog(filter);
  }

  /** Get daily spend summary */
  getDailySpendSummary() {
    return this.budget.getDailySpendSummary();
  }
}

// ─── Error Types ───

export class X402SettlementRevertedError extends Error {
  constructor(public readonly txHash: Hash) {
    super(`x402 settlement transaction reverted (${txHash})`);
    this.name = 'X402SettlementRevertedError';
  }
}

export class X402PaymentError extends Error {
  constructor(
    message: string,
    public readonly paymentRequirements: X402PaymentRequirements
  ) {
    super(`x402 payment error: ${message}`);
    this.name = 'X402PaymentError';
  }
}

export class X402BudgetExceededError extends Error {
  constructor(
    public readonly reason: string,
    public readonly url: string,
    public readonly paymentRequirements: X402PaymentRequirements
  ) {
    super(`x402 budget exceeded: ${reason}`);
    this.name = 'X402BudgetExceededError';
  }
}

