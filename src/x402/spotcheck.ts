/**
 * @module x402/spotcheck
 * Fail-closed pre-pay listing and checker dispatch for x402 clients.
 *
 * withSpotCheck(config, opts) returns a new X402ClientConfig whose
 * onBeforePayment first runs the caller's hook, then allows payment only
 * after an explicit listing match and/or checker allow. A missing checker,
 * empty listing, mismatch, throw, timeout, or unrecognized network declines.
 *
 * Nothing is imported at runtime. There is no fail-open path and no flag
 * that defaults to skipping the check.
 */
import { USDC_ADDRESSES } from './types.js';
import type { X402ClientConfig, X402PaymentRequirements } from './types.js';

export interface SpotCheckDecision {
  allowed: boolean;
  verdict?: string;
  reason?: string;
  reason_code?: string;
  [k: string]: unknown;
}

export interface SpotCheckChecker {
  checkBeforePay?: (
    url: string,
    opts: Record<string, unknown>,
  ) => Promise<SpotCheckPeerDecision | null | undefined> | SpotCheckPeerDecision | null | undefined;
}

export interface SpotCheckOptions {
  /** Listing constraints and extra fields forwarded to a supplied checker. */
  check?: Record<string, unknown>;
  /** Hard timeout for the whole pre-pay check (default 2000 ms). */
  timeoutMs?: number;
  /** Caller-supplied checker. There is no default loader and no runtime import. */
  checker?: SpotCheckChecker | (() => Promise<SpotCheckChecker>);
  /** Loader for a caller-supplied checker (same as a function `checker`). */
  load?: () => Promise<SpotCheckChecker>;
}

interface SpotCheckPeerDecision {
  allowed?: boolean;
  verdict?: string;
  [k: string]: unknown;
}

interface Listing {
  price?: unknown;
  payTo?: string;
  network?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (ms <= 0) {
      reject(new Error('spot-check timeout'));
      return;
    }
    const t = setTimeout(() => reject(new Error('spot-check timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}

function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  return withTimeout(p, remaining(deadline));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function hasListingConstraint(check: Record<string, unknown>): boolean {
  return typeof check.expected === 'function'
    || (check.price !== undefined && check.price !== null)
    || nonEmptyString(check.payTo)
    || nonEmptyString(check.network);
}

function listingHasField(listing: Listing): boolean {
  return listing.price !== undefined && listing.price !== null
    || nonEmptyString(listing.payTo)
    || nonEmptyString(listing.network);
}

function checkerAllows(d: SpotCheckPeerDecision | null | undefined): boolean {
  return !!d && d.allowed === true && d.verdict !== 'skip';
}

function resolveChecker(opts: SpotCheckOptions): (() => Promise<SpotCheckChecker>) | undefined {
  const supplied = opts.checker ?? opts.load;
  if (!supplied) return undefined;
  if (typeof supplied === 'function') return supplied;
  return async () => supplied;
}

function caipOfAddressKey(key: string): string {
  return `eip155:${key.slice(key.lastIndexOf(':') + 1)}`;
}

/** Map an SDK or CAIP network to the id the checker judges, or null to fail closed. */
export function judgedSpotCheckNetwork(network: string | undefined): string | null {
  const raw = String(network ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const keys = Object.keys(USDC_ADDRESSES);

  for (const key of keys) {
    if (lower === key.toLowerCase()) return caipOfAddressKey(key);
  }

  const caip = /^eip155:([1-9]\d*)$/i.exec(raw);
  if (caip) {
    const mapped = `eip155:${caip[1]}`;
    return keys.some((key) => caipOfAddressKey(key) === mapped) ? mapped : null;
  }

  const nameMatches = keys.filter((key) => key.slice(0, key.lastIndexOf(':')).toLowerCase() === lower);
  if (nameMatches.length === 1) return caipOfAddressKey(nameMatches[0]);
  return null;
}

function atomicEqual(listingPrice: unknown, amount: string): boolean {
  try {
    const want = typeof listingPrice === 'bigint' ? listingPrice : BigInt(String(listingPrice).trim());
    const got = BigInt(amount);
    return want === got;
  } catch {
    return false;
  }
}

function listingMismatch(req: X402PaymentRequirements, listing: Listing): string {
  if (nonEmptyString(listing.payTo) && listing.payTo.toLowerCase() !== String(req.payTo).toLowerCase()) {
    return 'pay_to_mismatch';
  }
  if (nonEmptyString(listing.network)) {
    const want = judgedSpotCheckNetwork(listing.network);
    const got = judgedSpotCheckNetwork(req.network);
    if (!want || !got || want !== got) return 'network_mismatch';
  }
  if (listing.price !== undefined && listing.price !== null) {
    if (!atomicEqual(listing.price, String(req.amount ?? ''))) return 'price_mismatch';
  }
  return '';
}

async function listingFromExpected(
  expected: (url: string, req: X402PaymentRequirements) => Listing | undefined | null | Promise<Listing | undefined | null>,
  url: string,
  req: X402PaymentRequirements,
): Promise<Listing | undefined> {
  const listing = await expected(url, req);
  if (!listing || typeof listing !== 'object') return undefined;
  return listing;
}

/** Wrap an X402ClientConfig with fail-closed spot-check hooks. The input config is not mutated. */
export function withSpotCheck(config: X402ClientConfig = {}, opts: SpotCheckOptions = {}): X402ClientConfig {
  const load = resolveChecker(opts);
  let loaded: Promise<SpotCheckChecker | null> | null = null;
  const getChecker = () => (loaded ??= load ? load().catch(() => null) : Promise.resolve(null));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userBefore = config.onBeforePayment;

  const onBeforePayment = async (req: X402PaymentRequirements, url: string): Promise<boolean> => {
    if (userBefore && (await userBefore(req, url)) === false) return false;
    const check = { ...(opts.check ?? {}) };
    const hasLocal = hasListingConstraint(check);
    if (!load && !hasLocal) return false;

    const deadline = Date.now() + timeoutMs;
    try {
      const peerNetwork = judgedSpotCheckNetwork(req.network);
      if (!peerNetwork) return false;

      let listing: Listing | undefined;
      if (typeof check.expected === 'function') {
        listing = await withDeadline(
          listingFromExpected(
            check.expected as (
              url: string,
              req: X402PaymentRequirements,
            ) => Listing | undefined | null | Promise<Listing | undefined | null>,
            url,
            req,
          ),
          deadline,
        );
        if (!listing || !listingHasField(listing)) return false;
      } else if (
        (check.price !== undefined && check.price !== null)
        || nonEmptyString(check.payTo)
        || nonEmptyString(check.network)
      ) {
        listing = {
          ...(check.price !== undefined && check.price !== null ? { price: check.price } : {}),
          ...(nonEmptyString(check.payTo) ? { payTo: check.payTo } : {}),
          ...(nonEmptyString(check.network) ? { network: check.network } : {}),
        };
      }

      if (listing && listingMismatch(req, listing)) return false;

      if (!load) return true;

      const checker = await withDeadline(getChecker(), deadline);
      if (!checker || typeof checker.checkBeforePay !== 'function') return false;

      const { expected: _expected, ...rest } = check;
      const accept = { ...req, network: peerNetwork };
      const d = await withDeadline(Promise.resolve(checker.checkBeforePay(url, {
        ...rest,
        ...(listing?.price !== undefined && listing.price !== null ? { price: listing.price } : {}),
        ...(listing?.payTo ? { payTo: listing.payTo } : {}),
        ...(listing?.network ? { network: judgedSpotCheckNetwork(listing.network) ?? peerNetwork } : {}),
        accepts: [accept],
      })), deadline);
      return checkerAllows(d);
    } catch {
      return false;
    }
  };

  return { ...config, onBeforePayment };
}
