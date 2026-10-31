/**
 * @module x402/spotcheck
 * Fail-closed pre-pay listing and checker dispatch for x402 clients.
 *
 * withSpotCheck(config, opts) returns a new X402ClientConfig whose
 * onBeforePayment snapshots the selected terms, then runs the caller's hook
 * and the whole spot check under one monotonic deadline. Payment proceeds
 * only after an explicit listing match and/or checker allow against that
 * snapshot, and only if the deadline is still open when the decision is
 * accepted. A missing checker, empty listing, mismatch, throw, timeout,
 * hang, late allow, or unrecognized network declines.
 *
 * A checker allows only when allowed === true and verdict === 'allow'.
 * Static listing fields apply together with expected(); conflicts refuse.
 *
 * Nothing is imported at runtime. There is no fail-open path and no flag
 * that defaults to skipping the check.
 */
import { USDC_ADDRESSES } from './types.js';
import type { X402ClientConfig, X402PaymentRequirements } from './types.js';

const SPOT_CHECK_VERDICT_ALLOW = 'allow';

export interface SpotCheckDecision {
  allowed: boolean;
  /** Must be `allow` (with allowed === true) for a checker to authorize payment. */
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

export interface SpotCheckClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
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
  /** Injectable monotonic clock. Tests supply a fake; production uses performance.now(). */
  clock?: SpotCheckClock;
}

interface Listing {
  price?: unknown;
  payTo?: string;
  network?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 60_000;
const SPOT_CHECK_TIMEOUT = 'spot-check timeout';

const DEFAULT_CLOCK: SpotCheckClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => { clearTimeout(id as ReturnType<typeof setTimeout>); },
};
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

function cloneRequirements(req: X402PaymentRequirements): X402PaymentRequirements {
  return JSON.parse(JSON.stringify(req)) as X402PaymentRequirements;
}

function requireTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error('withSpotCheck: timeoutMs must be a finite number greater than 0 and at most 60000');
  }
  return value;
}

function runUnderDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  clock: SpotCheckClock,
): Promise<T> {
  const deadlineAt = clock.now() + timeoutMs;
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const remain = deadlineAt - clock.now();
    if (remain <= 0) {
      controller.abort();
      reject(new Error(SPOT_CHECK_TIMEOUT));
      return;
    }
    const timer: { id?: unknown } = {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer.id);
      fn();
    };
    timer.id = clock.setTimeout(() => {
      finish(() => {
        controller.abort();
        reject(new Error(SPOT_CHECK_TIMEOUT));
      });
    }, remain);
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value) => {
          finish(() => {
            if (clock.now() >= deadlineAt) {
              controller.abort();
              reject(new Error(SPOT_CHECK_TIMEOUT));
              return;
            }
            resolve(value);
          });
        },
        (err) => {
          finish(() => reject(err));
        },
      );
  });
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
  return !!d && d.allowed === true && d.verdict === SPOT_CHECK_VERDICT_ALLOW;
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

function listingsConflict(left: Listing, right: Listing): boolean {
  if (nonEmptyString(left.payTo) && nonEmptyString(right.payTo)
    && left.payTo.toLowerCase() !== right.payTo.toLowerCase()) {
    return true;
  }
  if (nonEmptyString(left.network) && nonEmptyString(right.network)) {
    const want = judgedSpotCheckNetwork(left.network);
    const got = judgedSpotCheckNetwork(right.network);
    if (!want || !got || want !== got) return true;
  }
  if (left.price !== undefined && left.price !== null
    && right.price !== undefined && right.price !== null) {
    try {
      const a = typeof left.price === 'bigint' ? left.price : BigInt(String(left.price).trim());
      const b = typeof right.price === 'bigint' ? right.price : BigInt(String(right.price).trim());
      return a !== b;
    } catch {
      return true;
    }
  }
  return false;
}

function mergeListings(staticListing: Listing, expectedListing: Listing): Listing | undefined {
  if (listingsConflict(staticListing, expectedListing)) return undefined;
  return {
    ...expectedListing,
    ...listingFromFields(staticListing),
  };
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
  return listingFromFields(listing);
}

/** Wrap an X402ClientConfig with fail-closed spot-check hooks. The input config is not mutated. */
export function withSpotCheck(config: X402ClientConfig = {}, opts: SpotCheckOptions = {}): X402ClientConfig {
  const load = resolveChecker(opts);
  let loaded: Promise<SpotCheckChecker | null> | null = null;
  const getChecker = () => (loaded ??= load ? load().catch(() => null) : Promise.resolve(null));
  const timeoutMs = requireTimeoutMs(opts.timeoutMs);
  const clock = opts.clock ?? DEFAULT_CLOCK;
  const userBefore = config.onBeforePayment;

  const onBeforePayment = async (req: X402PaymentRequirements, url: string): Promise<boolean> => {
    const snapshot = cloneRequirements(req);
    try {
      return await runUnderDeadline(async (signal) => {
        if (userBefore && (await userBefore(req, url)) === false) return false;
        const check = { ...(opts.check ?? {}) };
        if (!load && !hasListingConstraint(check)) return false;

        const judgedNetwork = judgedSpotCheckNetwork(snapshot.network);
        if (!judgedNetwork) return false;

        const staticListing = listingFromFields(check);
        let listing: Listing | undefined;
        if (typeof check.expected === 'function') {
          listing = await listingFromExpected(
            check.expected as (
              url: string,
              req: X402PaymentRequirements,
            ) => Listing | undefined | null | Promise<Listing | undefined | null>,
            url,
            cloneRequirements(snapshot),
          );
          if (!listing || !listingHasField(listing)) return false;
          if (listingHasField(staticListing)) {
            listing = mergeListings(staticListing, listing);
            if (!listing) return false;
          }
        } else if (listingHasField(staticListing)) {
          listing = staticListing;
        }

        if (listing && listingMismatch(snapshot, listing, judgedNetwork)) return false;
        if (!load) return true;

        const checker = await getChecker();
        if (!checker || typeof checker.checkBeforePay !== 'function') return false;

        const { expected: _expected, ...rest } = check;
        const accept = { ...snapshot, network: judgedNetwork };
        const d = await checker.checkBeforePay(url, {
          ...rest,
          signal,
          ...(listing?.price !== undefined && listing.price !== null ? { price: listing.price } : {}),
          ...(listing && nonEmptyString(listing.payTo) ? { payTo: listing.payTo } : {}),
          ...(listing && nonEmptyString(listing.network) ? { network: judgedNetwork } : {}),
          accepts: [accept],
        });
        return checkerAllows(d);
      }, timeoutMs, clock);
    } catch {
      return false;
    }
  };

  return { ...config, onBeforePayment };
}
