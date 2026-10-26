/**
 * Stellar x402 Payment Adapter
 *
 * Implements the x402 payment protocol on the Stellar network.
 *
 * Chain identifiers:
 *   - Stellar Mainnet: "stellar:pubnet"
 *   - Stellar Testnet: "stellar:testnet"
 *
 * Safety model (see SECURITY.md):
 * - A 402 challenge is accepted only when X-Payment-Chains contains the
 *   adapter's exact chain id. Bare or ambiguous "stellar" tokens are rejected.
 * - The configured Horizon endpoint is used for every call and must report the
 *   configured network passphrase before any account load or submission.
 * - Every Horizon call has an end-to-end deadline and a response size cap.
 * - Automatic payment requires a fail-closed spending policy (per-payment cap,
 *   optional cumulative budget, recipient allowlist, approval callback) and a
 *   reservation before the signer is invoked.
 * - A submission is "successful" only when Horizon returns the hash computed
 *   from the signed envelope, an explicit successful=true, and a confirmation
 *   read shows the same transaction in a ledger. Ambiguous submissions are
 *   reported as unknown and keep their reservation.
 *
 * Requires @stellar/stellar-sdk (optional peer dependency) for XDR handling.
 */

import { boundedFetch, parseBoundedJson, BoundedFetchError } from '../../../net/bounded-fetch.js';

// ─── Stellar Chain Constants ─────────────────────────────────────────────────

export const STELLAR_NETWORK = {
  pubnet: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    chainId: 'stellar:pubnet',
  },
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    chainId: 'stellar:testnet',
  },
} as const;

/**
 * Circle USDC on Stellar
 * Asset code: USDC
 */
export const STELLAR_USDC = {
  pubnet: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  testnet: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
} as const;

/** Per-request Horizon deadline. */
export const STELLAR_HORIZON_TIMEOUT_MS = 15_000;
/** Horizon response size cap. */
export const STELLAR_HORIZON_MAX_BYTES = 256 * 1024;

const STELLAR_ACCOUNT_ID = /^G[A-Z2-7]{55}$/;
const STELLAR_AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,7})?$/;
const STELLAR_TX_HASH = /^[0-9a-f]{64}$/;

// ─── Types ────────────────────────────────────────────────────────────────────

export type StellarNetwork = 'pubnet' | 'testnet';

export interface StellarPaymentConfig {
  /** Which Stellar network to use (default: pubnet). */
  network?: StellarNetwork;
  /** x402 resource identifier (for memo) */
  resource?: string;
  /** Custom Horizon URL. Must serve the configured network. */
  horizonUrl?: string;
  /** Optional separate Horizon used to confirm submissions (default: horizonUrl). */
  confirmationHorizonUrl?: string;
  /** Per-request deadline (default 15 s). */
  timeoutMs?: number;
  /** Fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

export interface StellarPaymentRequest {
  /** Destination Stellar account (G... address) */
  destination: string;
  /** Amount in USDC (decimal string, at most 7 fractional digits) */
  amount: string;
  /** Source Stellar account public key */
  sourcePublicKey: string;
  /** x402 resource path for memo */
  resource?: string;
  /** Must equal the adapter's network when supplied. */
  network?: StellarNetwork;
}

export interface StellarPaymentResult {
  /** Stellar transaction hash (hex) */
  hash: string;
  /** Ledger number the transaction landed in */
  ledger: number;
  /** Always true for a returned result; failures throw. */
  successful: boolean;
  /** Network used */
  network: StellarNetwork;
}

/** Thrown when a signed transaction may or may not have been applied. Do not resubmit a different payment. */
export class StellarSubmissionUnknownError extends Error {
  readonly name = 'StellarSubmissionUnknownError';
  constructor(readonly expectedHash: string | undefined, message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Thrown before signing when a Stellar payment violates the safety policy. */
export class StellarPaymentPolicyError extends Error {
  readonly name = 'StellarPaymentPolicyError';
}

/** Definite non-payment: Horizon rejected the envelope, or it was included but its operation failed. */
export class StellarTransactionRejectedError extends Error {
  readonly name = 'StellarTransactionRejectedError';
  constructor(message: string, readonly hash?: string) {
    super(message);
  }
}

// ─── Amount helpers (7-decimal stroops, exact) ────────────────────────────────

/** Convert a Stellar decimal amount to integer stroops (1e-7). Throws on invalid input. */
export function stellarAmountToStroops(amount: string): bigint {
  if (typeof amount !== 'string' || !STELLAR_AMOUNT.test(amount)) {
    throw new StellarPaymentPolicyError(`invalid Stellar amount "${String(amount)}"`);
  }
  const [i, f = ''] = amount.split('.');
  const stroops = BigInt(i) * 10_000_000n + BigInt(f.padEnd(7, '0'));
  if (stroops <= 0n) throw new StellarPaymentPolicyError('Stellar amount must be positive');
  return stroops;
}

// ─── Optional SDK loader ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadStellarSdk(): Promise<any> {
  try {
    // @ts-expect-error — @stellar/stellar-sdk is an optional peer dependency
    return await import('@stellar/stellar-sdk');
  } catch {
    throw new Error('Stellar support requires @stellar/stellar-sdk: npm install @stellar/stellar-sdk');
  }
}

// ─── Stellar x402 Payment Adapter ────────────────────────────────────────────

export class StellarX402Adapter {
  private readonly network: StellarNetwork;
  private readonly horizonUrl: string;
  private readonly confirmationHorizonUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly verifiedHorizons = new Set<string>();

  constructor(config: StellarPaymentConfig = {}) {
    const network = config.network ?? 'pubnet';
    if (network !== 'pubnet' && network !== 'testnet') {
      throw new Error(`Unsupported Stellar network "${String(network)}"`);
    }
    this.network = network;
    this.horizonUrl = normalizeHorizonUrl(config.horizonUrl ?? STELLAR_NETWORK[network].horizonUrl);
    this.confirmationHorizonUrl = normalizeHorizonUrl(config.confirmationHorizonUrl ?? this.horizonUrl);
    this.timeoutMs = config.timeoutMs ?? STELLAR_HORIZON_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl;
  }

  /** Chain ID for this adapter (e.g. "stellar:pubnet") */
  get chainId(): string {
    return STELLAR_NETWORK[this.network].chainId;
  }

  /** The Horizon endpoint used for account loading and submission. */
  get horizon(): string {
    return this.horizonUrl;
  }

  /**
   * Parse an x402 402 response and extract Stellar payment details.
   * Supported only when X-Payment-Chains contains this adapter's EXACT chain id.
   */
  parseX402Response(headers: Record<string, string>): {
    supported: boolean;
    destination?: string;
    amount?: string;
    resource?: string;
  } {
    const header = (name: string) => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    };
    const chains = (header('X-Payment-Chains') ?? '')
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (!chains.includes(this.chainId)) {
      return { supported: false };
    }
    return {
      supported: true,
      destination: header('X-Payment-Destination')?.trim(),
      amount: header('X-Payment-Amount')?.trim(),
      resource: header('X-Payment-Resource'),
    };
  }

  /**
   * Build a Stellar USDC payment transaction on the adapter's network.
   * Returns the XDR-encoded transaction envelope for signing and submission.
   */
  async buildPaymentTransaction(request: StellarPaymentRequest): Promise<string> {
    if (request.network !== undefined && request.network !== this.network) {
      throw new StellarPaymentPolicyError(`request network ${request.network} differs from adapter network ${this.network}`);
    }
    if (!STELLAR_ACCOUNT_ID.test(request.destination)) {
      throw new StellarPaymentPolicyError('destination must be a Stellar account id (G...)');
    }
    if (!STELLAR_ACCOUNT_ID.test(request.sourcePublicKey)) {
      throw new StellarPaymentPolicyError('sourcePublicKey must be a Stellar account id (G...)');
    }
    stellarAmountToStroops(request.amount);
    const StellarSdk = await loadStellarSdk();
    const networkConfig = STELLAR_NETWORK[this.network];
    const usdcAsset = STELLAR_USDC[this.network];

    await this.assertHorizonNetwork(this.horizonUrl);
    const account = await this.loadAccount(request.sourcePublicKey);
    const stellarAccount = new StellarSdk.Account(request.sourcePublicKey, account.sequence);
    const asset = new StellarSdk.Asset(usdcAsset.code, usdcAsset.issuer);

    const memoText = truncateUtf8(request.resource ?? 'x402-payment', 28); // Stellar text memo: 28 bytes

    const transaction = new StellarSdk.TransactionBuilder(stellarAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.payment({ destination: request.destination, asset, amount: request.amount }))
      .addMemo(StellarSdk.Memo.text(memoText))
      .setTimeout(300) // 5 minute window
      .build();

    return transaction.toXDR();
  }

  /**
   * Submit a signed Stellar transaction to the configured Horizon and confirm
   * it. Throws StellarSubmissionUnknownError when the outcome is ambiguous.
   */
  async submitTransaction(signedXdr: string): Promise<StellarPaymentResult> {
    const StellarSdk = await loadStellarSdk();
    const networkConfig = STELLAR_NETWORK[this.network];
    let expectedHash: string;
    try {
      const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkConfig.networkPassphrase);
      expectedHash = Buffer.from(tx.hash()).toString('hex').toLowerCase();
      if (!STELLAR_TX_HASH.test(expectedHash)) throw new Error('unexpected transaction hash format');
    } catch (err) {
      throw new StellarPaymentPolicyError(`signed XDR is not a valid ${this.network} transaction: ${(err as Error).message}`);
    }
    await this.assertHorizonNetwork(this.horizonUrl);

    let res;
    try {
      res = await boundedFetch(`${this.horizonUrl}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ tx: signedXdr }).toString(),
      }, { timeoutMs: this.timeoutMs, maxBytes: STELLAR_HORIZON_MAX_BYTES, fetchImpl: this.fetchImpl });
    } catch (err) {
      // The POST may have reached Horizon: never infer non-payment.
      return this.confirmOrUnknown(expectedHash, `submission outcome unknown: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const body = safeJson(res.text);
      const resultCodes = (body as { extras?: { result_codes?: unknown } } | undefined)?.extras?.result_codes;
      if (res.status >= 400 && res.status < 500 && resultCodes) {
        // Horizon rejected the envelope with explicit result codes.
        throw new StellarTransactionRejectedError(`Stellar transaction rejected: ${res.status} ${JSON.stringify(resultCodes).slice(0, 200)}`, expectedHash);
      }
      return this.confirmOrUnknown(expectedHash, `Horizon returned ${res.status}; outcome unknown`);
    }

    const result = safeJson(res.text) as { hash?: unknown; ledger?: unknown; successful?: unknown } | undefined;
    if (!result || typeof result !== 'object') {
      return this.confirmOrUnknown(expectedHash, 'Horizon returned an unreadable success body');
    }
    if (typeof result.hash !== 'string' || result.hash.toLowerCase() !== expectedHash) {
      return this.confirmOrUnknown(expectedHash, 'Horizon success body does not reference the signed transaction');
    }
    if (result.successful !== true) {
      return this.confirmOrUnknown(expectedHash, 'Horizon success body lacks successful=true');
    }
    return this.confirmOrUnknown(expectedHash, 'submission accepted but confirmation failed');
  }

  /** Read the transaction back and require it to be successful in a ledger. */
  private async confirm(expectedHash: string): Promise<StellarPaymentResult> {
    await this.assertHorizonNetwork(this.confirmationHorizonUrl);
    const res = await boundedFetch(`${this.confirmationHorizonUrl}/transactions/${expectedHash}`, {
      headers: { Accept: 'application/json' },
    }, { timeoutMs: this.timeoutMs, maxBytes: STELLAR_HORIZON_MAX_BYTES, fetchImpl: this.fetchImpl });
    if (!res.ok) throw new StellarSubmissionUnknownError(expectedHash, `confirmation lookup returned ${res.status}`);
    const tx = safeJson(res.text) as { hash?: unknown; ledger?: unknown; successful?: unknown } | undefined;
    if (!tx || typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== expectedHash) {
      throw new StellarSubmissionUnknownError(expectedHash, 'confirmation does not reference the signed transaction');
    }
    if (typeof tx.ledger !== 'number' || !Number.isSafeInteger(tx.ledger) || tx.ledger <= 0) {
      throw new StellarSubmissionUnknownError(expectedHash, 'confirmation lacks a ledger');
    }
    if (tx.successful !== true) {
      throw new StellarTransactionRejectedError(`Stellar transaction ${expectedHash} was included but failed`, expectedHash);
    }
    return { hash: expectedHash, ledger: tx.ledger, successful: true, network: this.network };
  }

  private async confirmOrUnknown(expectedHash: string, message: string, cause?: unknown): Promise<StellarPaymentResult> {
    try {
      return await this.confirm(expectedHash);
    } catch (err) {
      if (err instanceof StellarSubmissionUnknownError || err instanceof BoundedFetchError) {
        throw new StellarSubmissionUnknownError(expectedHash, `${message}; reconcile transaction ${expectedHash} before any retry`, cause ?? err);
      }
      throw err;
    }
  }

  /** Require that a Horizon endpoint serves this adapter's network. */
  private async assertHorizonNetwork(horizonUrl: string): Promise<void> {
    if (this.verifiedHorizons.has(horizonUrl)) return;
    const res = await boundedFetch(`${horizonUrl}/`, { headers: { Accept: 'application/json' } }, {
      timeoutMs: this.timeoutMs, maxBytes: STELLAR_HORIZON_MAX_BYTES, fetchImpl: this.fetchImpl,
    });
    const root = res.ok ? safeJson(res.text) as { network_passphrase?: unknown } | undefined : undefined;
    const expected = STELLAR_NETWORK[this.network].networkPassphrase;
    if (root?.network_passphrase !== expected) {
      throw new StellarPaymentPolicyError(`Horizon ${horizonUrl} does not serve the ${this.network} network`);
    }
    this.verifiedHorizons.add(horizonUrl);
  }

  private async loadAccount(publicKey: string): Promise<{ sequence: string }> {
    const res = await boundedFetch(`${this.horizonUrl}/accounts/${publicKey}`, { headers: { Accept: 'application/json' } }, {
      timeoutMs: this.timeoutMs, maxBytes: STELLAR_HORIZON_MAX_BYTES, fetchImpl: this.fetchImpl,
    });
    if (!res.ok) {
      throw new Error(
        `Cannot load Stellar account ${publicKey}: ${res.status}. ` +
        'Ensure the account exists and has a USDC trustline established.',
      );
    }
    const data = safeJson(res.text) as { sequence?: unknown } | undefined;
    if (!data || typeof data.sequence !== 'string' || !/^\d{1,20}$/.test(data.sequence)) {
      throw new Error(`Horizon returned an invalid sequence for ${publicKey}`);
    }
    return { sequence: data.sequence };
  }
}

// ─── Spending policy for automatic payments ──────────────────────────────────

export interface StellarSpendPolicy {
  /** Maximum USDC per payment (decimal string). Required. */
  maxPerPayment: string;
  /** Allowed destination accounts. When non-empty, any other destination is refused. */
  allowedDestinations?: string[];
  /** Cumulative budget shared across payments (recommended). */
  budget?: StellarSpendBudget;
  /** Final approval hook; must resolve to true to proceed. */
  approve?: (details: { destination: string; amount: string; resource?: string; network: StellarNetwork }) => Promise<boolean> | boolean;
}

type StellarReservationState = 'held' | 'committed' | 'released' | 'unknown';

/**
 * In-memory cumulative USDC budget for Stellar x402 payments. Reservations are
 * taken before signing; unknown submissions keep their capacity until the
 * caller reconciles them. Persist pending reservations before restarting.
 */
export class StellarSpendBudget {
  private readonly limit: bigint;
  private readonly reservations = new Map<string, { stroops: bigint; state: StellarReservationState; hash?: string }>();
  private seq = 0;

  constructor(maxTotal: string) {
    this.limit = stellarAmountToStroops(maxTotal);
  }

  /** Stroops currently held, unknown or committed. */
  get occupiedStroops(): bigint {
    let total = 0n;
    for (const r of this.reservations.values()) if (r.state !== 'released') total += r.stroops;
    return total;
  }

  reserve(amount: string): string {
    const stroops = stellarAmountToStroops(amount);
    if (this.occupiedStroops + stroops > this.limit) {
      throw new StellarPaymentPolicyError('Stellar spend budget exceeded');
    }
    const id = `stellar-${++this.seq}`;
    this.reservations.set(id, { stroops, state: 'held' });
    return id;
  }

  commit(id: string, hash: string): void {
    const r = this.reservations.get(id);
    if (r && (r.state === 'held' || r.state === 'unknown')) { r.state = 'committed'; r.hash = hash; }
  }

  /** Release only before submission or after a definite rejection. */
  release(id: string): void {
    const r = this.reservations.get(id);
    if (r && r.state === 'held') r.state = 'released';
  }

  markUnknown(id: string, hash?: string): void {
    const r = this.reservations.get(id);
    if (r && r.state === 'held') { r.state = 'unknown'; r.hash = hash; }
  }

  /** Pending (unknown) reservations that need on-chain reconciliation. */
  unresolved(): Array<{ id: string; hash?: string; stroops: bigint }> {
    return [...this.reservations.entries()]
      .filter(([, r]) => r.state === 'unknown')
      .map(([id, r]) => ({ id, hash: r.hash, stroops: r.stroops }));
  }
}

// ─── x402 Auto-Pay Helper ────────────────────────────────────────────────────

/**
 * Full x402 payment flow for Stellar:
 * 1. Parses the 402 headers (exact chain id required)
 * 2. Enforces the spending policy and reserves budget BEFORE signing
 * 3. Builds, signs, submits and confirms the Stellar USDC payment
 *
 * A policy is mandatory; there is no unlimited auto-pay mode.
 */
export async function stellarX402Pay(params: {
  /** The 402 response headers */
  responseHeaders: Record<string, string>;
  /** Source account public key */
  sourcePublicKey: string;
  /** Signer function that takes XDR and returns signed XDR */
  sign: (xdr: string) => Promise<string>;
  /** Network to use (default pubnet) */
  network?: StellarNetwork;
  /** Mandatory fail-closed spending policy. */
  policy: StellarSpendPolicy;
  /** Optional adapter overrides (Horizon URL, timeouts). */
  adapter?: Omit<StellarPaymentConfig, 'network'>;
}): Promise<StellarPaymentResult> {
  const network = params.network ?? 'pubnet';
  const policy = params.policy;
  if (!policy || typeof policy !== 'object' || typeof policy.maxPerPayment !== 'string') {
    throw new StellarPaymentPolicyError('stellarX402Pay requires a spending policy with maxPerPayment');
  }
  const perPaymentCap = stellarAmountToStroops(policy.maxPerPayment);
  const adapter = new StellarX402Adapter({ ...params.adapter, network });

  const details = adapter.parseX402Response(params.responseHeaders);
  if (!details.supported) {
    throw new StellarPaymentPolicyError(`This endpoint does not offer ${adapter.chainId} x402 payments`);
  }
  if (!details.destination || !details.amount) {
    throw new StellarPaymentPolicyError('x402 response missing destination or amount headers');
  }
  if (!STELLAR_ACCOUNT_ID.test(details.destination)) {
    throw new StellarPaymentPolicyError('x402 destination is not a Stellar account id');
  }
  const stroops = stellarAmountToStroops(details.amount);
  if (stroops > perPaymentCap) {
    throw new StellarPaymentPolicyError(`x402 amount ${details.amount} exceeds maxPerPayment ${policy.maxPerPayment}`);
  }
  const allowed = policy.allowedDestinations ?? [];
  if (allowed.length > 0 && !allowed.includes(details.destination)) {
    throw new StellarPaymentPolicyError(`destination ${details.destination} is not allowed`);
  }
  if (policy.approve) {
    const ok = await policy.approve({ destination: details.destination, amount: details.amount, resource: details.resource, network });
    if (ok !== true) throw new StellarPaymentPolicyError('payment was not approved');
  }

  const reservationId = policy.budget?.reserve(details.amount);
  let submitted = false;
  try {
    const xdr = await adapter.buildPaymentTransaction({
      destination: details.destination,
      amount: details.amount,
      sourcePublicKey: params.sourcePublicKey,
      resource: details.resource,
      network,
    });
    const signedXdr = await params.sign(xdr);
    submitted = true;
    const result = await adapter.submitTransaction(signedXdr);
    if (reservationId) policy.budget!.commit(reservationId, result.hash);
    return result;
  } catch (err) {
    if (reservationId) {
      if (err instanceof StellarSubmissionUnknownError) policy.budget!.markUnknown(reservationId, err.expectedHash);
      else if (!submitted || err instanceof StellarPaymentPolicyError || err instanceof StellarTransactionRejectedError) policy.budget!.release(reservationId);
      else policy.budget!.markUnknown(reservationId);
    }
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeHorizonUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Horizon URL "${url}"`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Horizon URL must use https (http only for localhost)');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function safeJson(text: string): unknown {
  try {
    return parseBoundedJson(text, 'Horizon response');
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const ch of value) {
    if (encoder.encode(out + ch).byteLength > maxBytes) break;
    out += ch;
  }
  return out;
}
