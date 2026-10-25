/**
 * @module x402/spotcheck
 * Optional, opt-in pre-pay and after-pay checks via x402-spotcheck (optional peer, >= 1.2.0).
 *
 * withSpotCheck(config, opts) returns a new X402ClientConfig whose
 *  - onBeforePayment first runs your own hook (a `false` still declines), then asks x402-spotcheck
 *    whether the selected payment terms look wrong (local rules by default, no network calls; or
 *    the 402xAgent service with `check: { mode: 'service' }`). A `skip` verdict declines the payment.
 *    `check.expected` is evaluated here. A listing mismatch, or a network the peer cannot judge,
 *    declines the payment. A denial short-circuits `fits()`; a throw from `fits()` declines.
 *  - onPaymentComplete runs your own hook, then (only with `afterPay: true`) asks whether a failed
 *    or unconfirmed transfer actually landed on-chain, reporting the answer to `onAfterPay`.
 *    After-pay also watches the client's fetch/settle paths so receipt throws (before the
 *    completion hook) and paid-request failures (after a success:true completion) are looked up.
 *
 * Fail-open: if x402-spotcheck is not installed, times out, or `checkBeforePay` throws, the
 * pre-pay check lets the payment proceed. Expected, network, and `fits()` denials fail closed.
 */
import { X402Client } from './client.js';
import type { X402ClientConfig, X402PaymentRequirements, X402TransactionLog } from './types.js';

export interface SpotCheckDecision {
  allowed: boolean;
  verdict?: string;
  reason?: string;
  reason_code?: string;
  [k: string]: unknown;
}

export interface SpotCheckOptions {
  /** Run the pre-pay check (default true). */
  prePay?: boolean;
  /** Run the after-pay check for failed/unconfirmed transfers (default false). */
  afterPay?: boolean;
  /** Options passed to x402-spotcheck checkBeforePay (e.g. { mode: 'service', client, expected }). */
  check?: Record<string, unknown>;
  /** Options passed to x402-spotcheck afterPay. */
  afterPayOptions?: Record<string, unknown>;
  /** Hard timeout for the pre-pay check; on timeout the payment proceeds (default 2000 ms). */
  timeoutMs?: number;
  /** Observer for every pre-pay decision (never blocks). */
  onDecision?: (d: SpotCheckDecision | { allowed: true; error: string }, req: X402PaymentRequirements, url: string) => void;
  /** Receives the after-pay answer (status, safe_to_resign, receipt, ...). */
  onAfterPay?: (result: unknown, log: X402TransactionLog) => void;
  /** Module loader (tests / bundlers). Defaults to import('x402-spotcheck'). */
  load?: () => Promise<SpotCheckModule>;
}

interface SpotCheckModule {
  checkBeforePay?: (url: string, opts: Record<string, unknown>) => Promise<SpotCheckPeerDecision> | SpotCheckPeerDecision;
  afterPay?: (ref: { txHash: string }, opts: Record<string, unknown>) => Promise<unknown>;
  needsAfterPay?: (outcome: unknown) => boolean;
}

interface SpotCheckPeerDecision {
  allowed?: boolean;
  fits?: (req: Record<string, unknown>) => Promise<string> | string;
  [k: string]: unknown;
}

interface Listing {
  price?: number;
  payTo?: string;
  network?: string;
}

type AfterPayWatch = (outcome: unknown) => void;
type WatchedComplete = ((log: X402TransactionLog) => void) & { [AFTER_PAY_WATCH]?: AfterPayWatch };

const DEFAULT_TIMEOUT_MS = 2000;
const BASE_CAIP = 'eip155:8453';
const SOLANA_CAIP = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AFTER_PAY_WATCH = Symbol('x402SpotCheckAfterPay');
const loadDefault = () => import(/* webpackIgnore: true */ 'x402-spotcheck' as string) as Promise<SpotCheckModule>;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('x402-spotcheck timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Map an SDK or CAIP network to the id the peer actually judges, or null to fail closed. */
function judgedSpotCheckNetwork(network: string | undefined, solana = false): string | null {
  const raw = String(network ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'base' || lower === 'base:8453' || lower === BASE_CAIP) return BASE_CAIP;
  if (solana && (lower === 'solana' || raw === SOLANA_CAIP)) return SOLANA_CAIP;
  const evm = /^(?:[a-z0-9-]+:|eip155:)([1-9]\d*)$/i.exec(raw);
  if (evm) {
    const caip = `eip155:${evm[1]}`;
    return caip === BASE_CAIP ? BASE_CAIP : null;
  }
  return null;
}

function intentOf(req: X402PaymentRequirements): { network: string | null; payTo: string | null; priceUsd: number | null } {
  const isUsdc = String(req.asset ?? '').toLowerCase() === USDC_BASE;
  const priceUsd = isUsdc && /^\d+$/.test(String(req.amount ?? '')) ? Number(req.amount) / 1e6 : null;
  return { network: req.network ?? null, payTo: req.payTo ?? null, priceUsd };
}

async function listingFromExpected(
  expected: (url: string, intent: ReturnType<typeof intentOf>) => Listing | undefined | Promise<Listing | undefined>,
  url: string,
  req: X402PaymentRequirements,
): Promise<Listing | undefined> {
  const listing = await expected(url, intentOf(req));
  if (!listing || typeof listing !== 'object') return undefined;
  return listing;
}

function listingMismatch(req: X402PaymentRequirements, listing: Listing | undefined, solana: boolean): string {
  if (!listing) return '';
  if (listing.payTo && String(listing.payTo).toLowerCase() !== String(req.payTo).toLowerCase()) {
    return 'pay_to_mismatch';
  }
  if (listing.network !== undefined && listing.network !== null && String(listing.network) !== '') {
    const want = judgedSpotCheckNetwork(listing.network, solana);
    const got = judgedSpotCheckNetwork(req.network, solana);
    if (!want || !got || want !== got) return 'network_mismatch';
  }
  if (listing.price !== undefined && listing.price !== null) {
    const price = Number(listing.price);
    const amount = String(req.amount ?? '');
    if (!Number.isFinite(price) || price < 0 || !/^\d+$/.test(amount)) return 'price_mismatch';
    const usd = Number(amount) / 1e6;
    if (Math.abs(usd - price) > price * 0.01 + 1e-9) return 'price_mismatch';
  }
  return '';
}

function txHashOf(outcome: unknown, fallback?: X402TransactionLog): string | undefined {
  if (outcome && typeof outcome === 'object' && 'txHash' in outcome) {
    const hash = (outcome as { txHash?: unknown }).txHash;
    if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash;
  }
  const fromLog = fallback?.txHash;
  return typeof fromLog === 'string' && /^0x[0-9a-fA-F]{64}$/.test(fromLog) ? fromLog : undefined;
}

function defaultNeedsAfterPay(outcome: unknown): boolean {
  if (!outcome) return true;
  if (outcome instanceof Error) return true;
  const status = Number((outcome as { status?: unknown }).status);
  return status === 402 || status >= 500;
}

function logFromOutcome(outcome: unknown, last: X402TransactionLog | undefined, txHash: string): X402TransactionLog {
  if (last?.txHash === txHash) return last;
  return {
    timestamp: Math.floor(Date.now() / 1000),
    service: last?.service ?? '',
    url: last?.url ?? '',
    amount: last?.amount ?? 0n,
    token: last?.token ?? '0x0000000000000000000000000000000000000000',
    recipient: last?.recipient ?? '0x0000000000000000000000000000000000000000',
    txHash: txHash as X402TransactionLog['txHash'],
    network: last?.network ?? '',
    scheme: last?.scheme ?? 'exact',
    success: false,
    error: outcome instanceof Error ? outcome.message : 'after-pay failure',
  };
}

function installAfterPayWatch(): void {
  const proto = X402Client.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['fetch', 'settle402AndRetry'] as const) {
    const original = proto[name];
    if (!original || (original as { __spotCheckAfterPay?: boolean }).__spotCheckAfterPay) continue;
    const wrapped = async function (this: { config: X402ClientConfig }, ...args: unknown[]) {
      try {
        const result = await original.apply(this, args);
        (this.config.onPaymentComplete as WatchedComplete | undefined)?.[AFTER_PAY_WATCH]?.(result);
        return result;
      } catch (error) {
        (this.config.onPaymentComplete as WatchedComplete | undefined)?.[AFTER_PAY_WATCH]?.(error);
        throw error;
      }
    };
    (wrapped as { __spotCheckAfterPay?: boolean }).__spotCheckAfterPay = true;
    proto[name] = wrapped;
  }
}

/** Wrap an X402ClientConfig with the opt-in x402-spotcheck hooks. The input config is not mutated. */
export function withSpotCheck(config: X402ClientConfig = {}, opts: SpotCheckOptions = {}): X402ClientConfig {
  const load = opts.load ?? loadDefault;
  let mod: Promise<SpotCheckModule | null> | null = null;
  const getMod = () => (mod ??= load().catch(() => null));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userBefore = config.onBeforePayment;
  const userComplete = config.onPaymentComplete;
  let lastLog: X402TransactionLog | undefined;

  const report = (d: SpotCheckDecision | { allowed: true; error: string }, req: X402PaymentRequirements, url: string): void => {
    try { opts.onDecision?.(d, req, url); } catch { /* observers never block */ }
  };

  const onBeforePayment = async (req: X402PaymentRequirements, url: string): Promise<boolean> => {
    if (userBefore && (await userBefore(req, url)) === false) return false;
    if (opts.prePay === false) return true;
    try {
      const m = await withTimeout(getMod(), timeoutMs);
      if (!m || typeof m.checkBeforePay !== 'function') return true;
      const check = { ...(opts.check ?? {}) };
      const solana = check.solana === true;
      const peerNetwork = judgedSpotCheckNetwork(req.network, solana);
      if (!peerNetwork) {
        report({ allowed: false, verdict: 'skip', reason_code: 'network_unrecognized', reason: `network ${req.network || 'unknown'} not judged` }, req, url);
        return false;
      }
      let listing: Listing | undefined;
      if (typeof check.expected === 'function') {
        try {
          listing = await withTimeout(
            listingFromExpected(
              check.expected as (url: string, intent: ReturnType<typeof intentOf>) => Listing | undefined | Promise<Listing | undefined>,
              url,
              req,
            ),
            timeoutMs,
          );
        } catch (e) {
          report({ allowed: false, verdict: 'skip', reason: String((e as Error)?.message ?? e) }, req, url);
          return false;
        }
      } else if ((check.price !== undefined && check.price !== null) || typeof check.payTo === 'string' || typeof check.network === 'string') {
        listing = {
          ...(check.price !== undefined && check.price !== null ? { price: Number(check.price) } : {}),
          ...(typeof check.payTo === 'string' ? { payTo: check.payTo } : {}),
          ...(typeof check.network === 'string' ? { network: check.network } : {}),
        };
      }
      const mismatch = listingMismatch(req, listing, solana);
      if (mismatch) {
        report({ allowed: false, verdict: 'skip', reason_code: mismatch, reason: mismatch }, req, url);
        return false;
      }
      const { expected: _expected, ...rest } = check;
      const accept = { ...req, network: peerNetwork };
      const d = await withTimeout(Promise.resolve(m.checkBeforePay(url, {
        ...rest,
        ...(listing?.price !== undefined && listing.price !== null ? { price: listing.price } : {}),
        ...(listing?.payTo ? { payTo: listing.payTo } : {}),
        ...(listing?.network ? { network: judgedSpotCheckNetwork(listing.network, solana) ?? peerNetwork } : {}),
        accepts: [accept],
      })), timeoutMs);
      if (d && d.allowed === false) {
        report({ ...(d as SpotCheckDecision), allowed: false }, req, url);
        return false;
      }
      if (d && typeof d.fits === 'function') {
        try {
          const why = await withTimeout(Promise.resolve(d.fits(accept)), timeoutMs);
          if (why) {
            report({ ...(d as SpotCheckDecision), allowed: false, reason: String(why) }, req, url);
            return false;
          }
        } catch (e) {
          report({ allowed: false, verdict: 'skip', reason: String((e as Error)?.message ?? e) }, req, url);
          return false;
        }
      }
      report({ ...(d ?? {}), allowed: true }, req, url);
      return true;
    } catch (e) {
      report({ allowed: true, error: String((e as Error)?.message ?? e) }, req, url);
      return true; // fail-open: missing module / checkBeforePay throw / timeout
    }
  };

  const runAfterPay = (ref: { txHash: string }, log: X402TransactionLog): void => {
    void (async () => {
      try {
        const m = await getMod();
        if (!m || typeof m.afterPay !== 'function') return;
        const r = await m.afterPay(ref, opts.afterPayOptions ?? {});
        opts.onAfterPay?.(r, log);
      } catch { /* fail-open: never affects the payment flow */ }
    })();
  };

  const onPaymentComplete = ((log: X402TransactionLog): void => {
    userComplete?.(log);
    lastLog = log;
    if (!opts.afterPay || log.success || !log.txHash) return;
    runAfterPay({ txHash: log.txHash }, log);
  }) as WatchedComplete;

  if (opts.afterPay) {
    installAfterPayWatch();
    onPaymentComplete[AFTER_PAY_WATCH] = (outcome: unknown) => {
      void (async () => {
        try {
          const m = await getMod();
          if (!m || typeof m.afterPay !== 'function') return;
          const needed = typeof m.needsAfterPay === 'function' ? m.needsAfterPay(outcome) : defaultNeedsAfterPay(outcome);
          if (!needed) return;
          const txHash = txHashOf(outcome, lastLog);
          if (!txHash) return;
          const r = await m.afterPay({ txHash }, opts.afterPayOptions ?? {});
          opts.onAfterPay?.(r, logFromOutcome(outcome, lastLog, txHash));
        } catch { /* fail-open: never affects the payment flow */ }
      })();
    };
  }

  return { ...config, onBeforePayment, onPaymentComplete };
}
