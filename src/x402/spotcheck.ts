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

const SPOT_CHECK_VERDICT_SKIP = 'skip';

export interface SpotCheckDecision {
  allowed: boolean;
  verdict?: string;
  reason?: string;
  reason_code?: string;
  [k: string]: unknown;
}

export interface SpotCheckChecker {
  checkBeforePay: (
    url: string,
    opts: Record<string, unknown>,
  ) => Promise<SpotCheckDecision | null | undefined> | SpotCheckDecision | null | undefined;
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

interface Listing {
  price?: unknown;
  payTo?: string;
  network?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const CAIP_BY_KEY = new Map<string, string>();
const CAIP_BY_NAME = new Map<string, string>();
const AMBIGUOUS_NAMES = new Set<string>();
const KNOWN_CAIPS = new Set<string>();

for (const key of Object.keys(USDC_ADDRESSES)) {
  const caip = `eip155:${key.slice(key.lastIndexOf(':') + 1)}`;
  CAIP_BY_KEY.set(key.toLowerCase(), caip);
  KNOWN_CAIPS.add(caip);
  const name = key.slice(0, key.lastIndexOf(':')).toLowerCase();
  if (AMBIGUOUS_NAMES.has(name) || (CAIP_BY_NAME.has(name) && CAIP_BY_NAME.get(name) !== caip)) {
    CAIP_BY_NAME.delete(name);
    AMBIGUOUS_NAMES.add(name);
  } else {
    CAIP_BY_NAME.set(name, caip);
  }
}

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

function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  return withTimeout(p, deadline - Date.now());
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function listingFromFields(source: Record<string, unknown> | Listing): Listing {
  return {
    ...(source.price !== undefined && source.price !== null ? { price: source.price } : {}),
    ...(nonEmptyString(source.payTo) ? { payTo: source.payTo } : {}),
    ...(nonEmptyString(source.network) ? { network: source.network } : {}),
  };
}

function listingHasField(listing: Listing): boolean {
  return listing.price !== undefined && listing.price !== null
    || nonEmptyString(listing.payTo)
    || nonEmptyString(listing.network);
}

function hasListingConstraint(check: Record<string, unknown>): boolean {
  return typeof check.expected === 'function' || listingHasField(listingFromFields(check));
}

function checkerAllows(d: SpotCheckDecision | null | undefined): boolean {
  return !!d && d.allowed === true && d.verdict !== SPOT_CHECK_VERDICT_SKIP;
}

function resolveChecker(opts: SpotCheckOptions): (() => Promise<SpotCheckChecker>) | undefined {
  const supplied = opts.checker ?? opts.load;
  if (!supplied) return undefined;
  if (typeof supplied === 'function') return supplied;
  return async () => supplied;
}

/** Map an SDK or CAIP network to the id the checker judges, or null to fail closed. */
export function judgedSpotCheckNetwork(network: string | undefined): string | null {
  const raw = String(network ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const fromKey = CAIP_BY_KEY.get(lower);
  if (fromKey) return fromKey;
  const caip = /^eip155:([1-9]\d*)$/i.exec(raw);
  if (caip) {
    const mapped = `eip155:${caip[1]}`;
    return KNOWN_CAIPS.has(mapped) ? mapped : null;
  }
  return CAIP_BY_NAME.get(lower) ?? null;
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

function listingMismatch(
  req: X402PaymentRequirements,
  listing: Listing,
  judgedNetwork: string,
): boolean {
  if (nonEmptyString(listing.payTo) && listing.payTo.toLowerCase() !== String(req.payTo).toLowerCase()) {
    return true;
  }
  if (nonEmptyString(listing.network)) {
    const want = judgedSpotCheckNetwork(listing.network);
    if (!want || want !== judgedNetwork) return true;
  }
  if (listing.price !== undefined && listing.price !== null) {
    return !atomicEqual(listing.price, String(req.amount ?? ''));
  }
  return false;
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
    if (!load && !hasListingConstraint(check)) return false;

    const deadline = Date.now() + timeoutMs;
    try {
      const judgedNetwork = judgedSpotCheckNetwork(req.network);
      if (!judgedNetwork) return false;

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
      } else {
        const staticListing = listingFromFields(check);
        if (listingHasField(staticListing)) listing = staticListing;
      }

      if (listing && listingMismatch(req, listing, judgedNetwork)) return false;
      if (!load) return true;

      const checker = await withDeadline(getChecker(), deadline);
      if (!checker || typeof checker.checkBeforePay !== 'function') return false;

      const { expected: _expected, ...rest } = check;
      const accept = { ...req, network: judgedNetwork };
      const d = await withDeadline(Promise.resolve(checker.checkBeforePay(url, {
        ...rest,
        ...(listing?.price !== undefined && listing.price !== null ? { price: listing.price } : {}),
        ...(listing && nonEmptyString(listing.payTo) ? { payTo: listing.payTo } : {}),
        ...(listing && nonEmptyString(listing.network) ? { network: judgedNetwork } : {}),
        accepts: [accept],
      })), deadline);
      return checkerAllows(d);
    } catch {
      return false;
    }
  };

  return { ...config, onBeforePayment };
}
