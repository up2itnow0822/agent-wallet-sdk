/**
 * Deadline- and size-bounded HTTP helper for untrusted endpoints
 * (Circle attestation, UAID brokers, Stellar Horizon, x402 merchants).
 *
 * One AbortController deadline covers connection, headers AND body
 * consumption, and the body is streamed with a hard byte cap. A slow or
 * oversized response therefore fails closed instead of hanging or exhausting
 * memory.
 */

export type BoundedFetchErrorCode = 'TIMEOUT' | 'TOO_LARGE' | 'NETWORK' | 'BAD_JSON';

export class BoundedFetchError extends Error {
  readonly code: BoundedFetchErrorCode;
  constructor(code: BoundedFetchErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'BoundedFetchError';
    this.code = code;
  }
}

export interface BoundedFetchOptions {
  /** End-to-end deadline for request + full body, in milliseconds. */
  timeoutMs: number;
  /** Maximum response body size in bytes. */
  maxBytes: number;
  /** Optional caller cancellation, combined with the deadline. */
  signal?: AbortSignal;
  /** Fetch implementation (defaults to global fetch; injectable for tests). */
  fetchImpl?: typeof fetch;
}

export interface BoundedResponse {
  ok: boolean;
  status: number;
  headers?: Headers;
  /** UTF-8 decoded body, at most maxBytes bytes. */
  text: string;
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** Fetch and fully read a response body within one deadline and byte cap. */
export async function boundedFetch(
  url: string,
  init: RequestInit = {},
  options: BoundedFetchOptions,
): Promise<BoundedResponse> {
  const { timeoutMs, maxBytes } = options;
  if (!(timeoutMs > 0) || !(maxBytes > 0)) {
    throw new BoundedFetchError('NETWORK', 'boundedFetch requires positive timeoutMs and maxBytes');
  }
  const controller = new AbortController();
  let timedOut = false;
  let internalAbort = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortInternally = () => { internalAbort = true; controller.abort(); };
  // Register the deadline listener BEFORE anything can abort the controller,
  // so an already-aborted caller signal still rejects immediately.
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      if (internalAbort) return; // our own size-limit abort reports TOO_LARGE itself
      void activeReader?.cancel().catch(() => undefined);
      reject(new BoundedFetchError(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut
        ? `request to ${url} exceeded ${timeoutMs} ms`
        : `request to ${url} was cancelled`));
    }, { once: true });
  });
  // Avoid an unhandled rejection when the work finishes first.
  deadline.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Both an options.signal and an init.signal from the caller cancel the request.
  const callerSignals = [options.signal, init.signal ?? undefined].filter(
    (sig): sig is AbortSignal => !!sig,
  );
  const onCallerAbort = () => controller.abort();
  for (const sig of callerSignals) {
    if (sig.aborted) controller.abort();
    else sig.addEventListener('abort', onCallerAbort, { once: true });
  }

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await Promise.race([
      doFetch(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    const declared = Number(response.headers?.get?.('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      abortInternally();
      throw new BoundedFetchError('TOO_LARGE', `response from ${url} declares ${declared} bytes (limit ${maxBytes})`);
    }
    const text = await Promise.race([
      readCapped(response, maxBytes, abortInternally, url, (r) => { activeReader = r; }),
      deadline,
    ]);
    return { ok: response.ok, status: response.status, headers: response.headers, text };
  } catch (err) {
    if (err instanceof BoundedFetchError) throw err;
    if (isAbort(err)) {
      throw new BoundedFetchError(timedOut ? 'TIMEOUT' : 'NETWORK', `request to ${url} aborted`, err);
    }
    throw new BoundedFetchError('NETWORK', `request to ${url} failed: ${(err as Error)?.message ?? String(err)}`, err);
  } finally {
    clearTimeout(timer);
    for (const sig of callerSignals) sig.removeEventListener('abort', onCallerAbort);
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
  abort: () => void,
  url: string,
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    onReader?.(reader);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        abort();
        void reader.cancel().catch(() => undefined); // never await: a tee branch cancel waits for its sibling
        throw new BoundedFetchError('TOO_LARGE', `response from ${url} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(all);
  }
  // Minimal Response-like objects (tests, exotic fetch polyfills) without a stream.
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new BoundedFetchError('TOO_LARGE', `response from ${url} exceeded ${maxBytes} bytes`);
  }
  return text;
}

/**
 * Like boundedFetch, but for already-received Response objects whose body was
 * not yet consumed (e.g. an x402 402 response). Reads the body under a fresh
 * deadline and cap; the original response body is consumed.
 */
export async function readBoundedText(
  response: Response,
  options: { timeoutMs: number; maxBytes: number; label?: string },
): Promise<string> {
  const label = options.label ?? 'response';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Cancel through the reader that holds the stream lock so the pending
      // read and the underlying connection are actually released.
      void reader?.cancel().catch(() => undefined);
      reject(new BoundedFetchError('TIMEOUT', `${label} body exceeded ${options.timeoutMs} ms`));
    }, options.timeoutMs);
  });
  deadline.catch(() => undefined);
  try {
    return await Promise.race([
      readCapped(response, options.maxBytes, () => { void reader?.cancel().catch(() => undefined); }, label, (r) => { reader = r; }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON from bounded text, mapping syntax errors to BoundedFetchError. */
export function parseBoundedJson(text: string, label = 'response'): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BoundedFetchError('BAD_JSON', `${label} is not valid JSON`, err);
  }
}
