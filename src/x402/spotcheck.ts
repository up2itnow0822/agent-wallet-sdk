/**
 * @module x402/spotcheck
 * Optional, opt-in pre-pay and after-pay checks via x402-spotcheck (optional peer, >= 1.2.0).
 *
 * withSpotCheck(config, opts) returns a new X402ClientConfig whose
 *  - onBeforePayment first runs your own hook (a `false` still declines), then asks x402-spotcheck
 *    whether the selected payment terms look wrong (local rules by default, no network calls; or
 *    the 402xAgent service with `check: { mode: 'service' }`). A `skip` verdict declines the payment.
 *  - onPaymentComplete runs your own hook, then (only with `afterPay: true`) asks whether a failed
 *    or unconfirmed transfer actually landed on-chain, reporting the answer to `onAfterPay`.
 *
 * Fail-open: if x402-spotcheck is not installed, times out, or throws, the payment proceeds exactly
 * as it would without this wrapper. Nothing changes unless you call withSpotCheck().
 */
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
  load?: () => Promise<any>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const loadDefault = () => import(/* webpackIgnore: true */ 'x402-spotcheck' as string);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('x402-spotcheck timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Wrap an X402ClientConfig with the opt-in x402-spotcheck hooks. The input config is not mutated. */
export function withSpotCheck(config: X402ClientConfig = {}, opts: SpotCheckOptions = {}): X402ClientConfig {
  const load = opts.load ?? loadDefault;
  let mod: Promise<any> | null = null;
  const getMod = () => (mod ??= load().catch(() => null));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userBefore = config.onBeforePayment;
  const userComplete = config.onPaymentComplete;

  const onBeforePayment = async (req: X402PaymentRequirements, url: string): Promise<boolean> => {
    if (userBefore && (await userBefore(req, url)) === false) return false;
    if (opts.prePay === false) return true;
    try {
      const m = await withTimeout(getMod(), timeoutMs);
      if (!m || typeof m.checkBeforePay !== 'function') return true;
      const accept = { ...req } as Record<string, unknown>;
      const d: any = await withTimeout(Promise.resolve(m.checkBeforePay(url, { ...(opts.check ?? {}), accepts: [accept] })), timeoutMs);
      const why = d && typeof d.fits === 'function' ? await withTimeout(Promise.resolve(d.fits(accept)), timeoutMs) : '';
      const allowed = !(d && d.allowed === false) && !why;
      try { opts.onDecision?.({ ...(d ?? {}), allowed, ...(why ? { reason: String(why) } : {}) }, req, url); } catch { /* observers never block */ }
      return allowed;
    } catch (e) {
      try { opts.onDecision?.({ allowed: true, error: String((e as Error)?.message ?? e) }, req, url); } catch { /* ignore */ }
      return true; // fail-open
    }
  };

  const onPaymentComplete = (log: X402TransactionLog): void => {
    userComplete?.(log);
    if (!opts.afterPay || log.success || !log.txHash) return;
    void (async () => {
      try {
        const m = await getMod();
        if (!m || typeof m.afterPay !== 'function') return;
        const r = await m.afterPay({ txHash: log.txHash }, opts.afterPayOptions ?? {});
        opts.onAfterPay?.(r, log);
      } catch { /* fail-open: never affects the payment flow */ }
    })();
  };

  return { ...config, onBeforePayment, onPaymentComplete };
}
