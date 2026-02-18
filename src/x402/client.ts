// [MAX-ADDED] x402 Client — automatic 402 payment handling for AgentWallet
import type { Address, Hash } from 'viem';
import { encodeFunctionData, parseAbi } from 'viem';
import type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402SettlementResponse,
  X402ClientConfig,
  X402TransactionLog,
} from './types.js';
import { USDC_ADDRESSES, DEFAULT_SUPPORTED_NETWORKS } from './types.js';
import { X402BudgetTracker } from './budget.js';
import { agentTransferToken, checkBudget } from '../index.js';

// ERC20 transfer ABI for encoding
const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

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
export class X402Client {
  private wallet: any; // ReturnType<typeof createWallet> — avoid circular import
  private config: X402ClientConfig;
  private budget: X402BudgetTracker;
  private supportedNetworks: Set<string>;

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
    const urlStr = url.toString();
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

    // Find a compatible payment option
    const selected = this.selectPaymentOption(paymentRequired.accepts);
    if (!selected) {
      return response; // No compatible payment option
    }

    // Check budget
    const amount = BigInt(selected.amount);
    const service = new URL(urlStr).hostname;
    const budgetCheck = this.budget.checkBudget(service, amount);
    if (!budgetCheck.allowed) {
      throw new X402BudgetExceededError(budgetCheck.reason!, urlStr, selected);
    }

    // Callback check
    if (this.config.onBeforePayment) {
      const proceed = await this.config.onBeforePayment(selected, urlStr);
      if (!proceed) {
        return response;
      }
    }

    // Execute payment
    const paymentResult = await this.executePayment(selected);

    // Build payment payload
    const paymentPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
      payload: {
        txHash: paymentResult.txHash,
        network: selected.network,
      },
    };

    // Log the transaction
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

  /**
   * Parse a 402 response to extract payment requirements.
   */
  async parse402Response(response: Response): Promise<X402PaymentRequired | null> {
    // Try PAYMENT-REQUIRED header first (standard x402)
    const headerValue = response.headers.get('payment-required')
      ?? response.headers.get('x-payment-required');

    if (headerValue) {
      try {
        const decoded = JSON.parse(atob(headerValue));
        return decoded as X402PaymentRequired;
      } catch {
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback
    try {
      const body = await response.clone().json();
      if (body.x402Version && body.accepts) {
        return body as X402PaymentRequired;
      }
    } catch {
      // Not parseable
    }

    return null;
  }

  /**
   * Select the best compatible payment option from offered requirements.
   * Prefers: Base network, USDC, exact scheme.
   */
  selectPaymentOption(accepts: X402PaymentRequirements[]): X402PaymentRequirements | null {
    // Filter to supported networks and known assets
    const compatible = accepts.filter(req => {
      if (!this.supportedNetworks.has(req.network)) return false;
      const networkAssets = this.config.supportedAssets?.[req.network]
        ?? [USDC_ADDRESSES[req.network]].filter(Boolean);
      return networkAssets.some(a => a.toLowerCase() === req.asset.toLowerCase());
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
   */
  private async executePayment(req: X402PaymentRequirements): Promise<{ txHash: Hash }> {
    // First check on-chain budget
    const onChainBudget = await checkBudget(this.wallet, req.asset as Address);
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

    // Execute the ERC20 transfer via AgentWallet
    const txHash = await agentTransferToken(this.wallet, {
      token: req.asset as Address,
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
