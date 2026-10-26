// [MAX-ADDED] x402 Middleware — wraps fetch/axios to be x402-aware
import type { X402ClientConfig } from './types.js';
import { X402Client } from './client.js';
import { toReplayableFetchArgs, withFailClosedRedirect } from './fetch-args.js';

/** Native-fetch-compatible execution and recovery on one retained payment client. */
export type X402Fetch = typeof globalThis.fetch & {
  readonly reconcileSubmission: X402Client['reconcileSubmission'];
};

/**
 * [MAX-ADDED] Create an x402-aware HTTP client.
 *
 * Usage:
 *   const client = createX402Client(wallet, { globalDailyLimit: 10_000_000n });
 *   const response = await client.fetch('https://api.example.com/data');
 *   // If the endpoint returns 402, payment is handled automatically
 *
 * @param wallet - AgentWallet instance from createWallet()
 * @param config - Optional x402 client configuration
 * @returns X402Client with .fetch() method and budget controls
 */
export function createX402Client(wallet: any, config?: X402ClientConfig): X402Client {
  return new X402Client(wallet, config);
}

/**
 * [MAX-ADDED] Create an x402-aware fetch function (drop-in replacement).
 *
 * Usage:
 *   const x402Fetch = createX402Fetch(wallet);
 *   const response = await x402Fetch('https://api.example.com/data');
 *
 * @param wallet - AgentWallet instance from createWallet()
 * @param config - Optional x402 client configuration
 * @returns A fetch-compatible function that handles 402 payments
 */
export function createX402Fetch(
  wallet: any,
  config?: X402ClientConfig
): X402Fetch {
  const client = new X402Client(wallet, config);
  const fetch: typeof globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    return client.fetch(input, init);
  };
  return Object.assign(fetch, { reconcileSubmission: client.reconcileSubmission.bind(client) });
}

/**
 * [MAX-ADDED] Wrap an existing fetch-like function to be x402-aware.
 * Useful for wrapping custom HTTP clients or test mocks.
 *
 * @param fetchFn - The original fetch function to wrap
 * @param wallet - AgentWallet instance
 * @param config - Optional x402 client configuration
 */
export function wrapWithX402(
  fetchFn: typeof globalThis.fetch,
  wallet: any,
  config?: X402ClientConfig
): X402Fetch {
  const wrappedClient = new X402Client(wallet, config);

  const fetch: typeof globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const { url, init: replayInit } = await toReplayableFetchArgs(input, init);
    // Snapshot every mutable request input BEFORE the first hop. A merchant
    // that delays its 402 cannot let caller-side mutation change the bytes
    // that get paid for or retried.
    const snapshot = withFailClosedRedirect(wrappedClient.snapshotRequestInitForRetry(replayInit), init);
    const response = await fetchFn(url, wrappedClient.snapshotRequestInitForRetry(snapshot));

    if (response.status !== 402) {
      return response;
    }

    return wrappedClient.settle402AndRetry(response, url, snapshot, fetchFn);
  };
  return Object.assign(fetch, { reconcileSubmission: wrappedClient.reconcileSubmission.bind(wrappedClient) });
}
