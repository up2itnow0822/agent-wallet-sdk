/**
 * Materialize fetch() arguments so method, headers, and body survive x402 retry.
 *
 * Native fetch accepts `Request`. The x402 client retries with `url + init`.
 * If a Request's method/body are dropped, POST/PUT paid endpoints are retried
 * as GET with an empty body — the payment is spent and the original write never
 * lands. Stream bodies are also consumed by the first attempt, so they must be
 * buffered before the 402 challenge.
 */

export type ReplayableFetchArgs = {
  url: string;
  init?: RequestInit;
};

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return true;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  return false;
}

async function materializeRequest(request: Request): Promise<ReplayableFetchArgs> {
  const headers = new Headers(request.headers);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: request.redirect,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
  };

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return { url: request.url, init };
}

/**
 * Convert fetch(input, init) into a url + replayable init pair.
 *
 * String/URL calls with already-replayable bodies are returned as-is so the
 * existing `client.fetch(url, { method, body: string })` path is unchanged.
 * Request objects and stream bodies are fully materialized.
 */
export async function toReplayableFetchArgs(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<ReplayableFetchArgs> {
  if (!(input instanceof Request)) {
    const url = input.toString();
    if (isReplayableBody(init?.body)) {
      return { url, init };
    }
    return materializeRequest(new Request(url, init));
  }

  const request = init !== undefined ? new Request(input, init) : input;
  return materializeRequest(request);
}
