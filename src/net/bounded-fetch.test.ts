import { describe, expect, it } from 'vitest';
import { boundedFetch, readBoundedText, BoundedFetchError } from './bounded-fetch.js';

const fetchOf = (r: () => Response | Promise<Response>) => (async () => r()) as unknown as typeof fetch;

describe('boundedFetch', () => {
  it('returns small bodies', async () => {
    const r = await boundedFetch('https://x', {}, { timeoutMs: 1000, maxBytes: 100, fetchImpl: fetchOf(() => new Response('ok')) });
    expect(r).toMatchObject({ ok: true, status: 200, text: 'ok' });
  });

  it('reports TOO_LARGE for a streamed body over the cap', async () => {
    const err = await boundedFetch('https://x', {}, {
      timeoutMs: 1000, maxBytes: 1024,
      fetchImpl: fetchOf(() => new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(800)); c.enqueue(new Uint8Array(800)); c.close(); },
      }))),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BoundedFetchError);
    expect(err.code).toBe('TOO_LARGE');
  });

  it('keeps the deadline running while the body is consumed (slow-loris body)', async () => {
    const err = await boundedFetch('https://x', {}, {
      timeoutMs: 30, maxBytes: 1024,
      fetchImpl: fetchOf(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); } }))),
    }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
  });

  it('times out when headers never arrive', async () => {
    const err = await boundedFetch('https://x', {}, {
      timeoutMs: 20, maxBytes: 10, fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
  });

  it('readBoundedText caps an already-received response', async () => {
    const err = await readBoundedText(new Response('x'.repeat(50)), { timeoutMs: 100, maxBytes: 10 }).catch((e) => e);
    expect(err.code).toBe('TOO_LARGE');
  });
});

describe('boundedFetch cancellation (review follow-ups)', () => {
  it('rejects immediately when the caller signal is already aborted, even if fetch ignores it', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const err = await boundedFetch('https://x', {}, {
      timeoutMs: 5_000, maxBytes: 10, signal: ac.signal,
      fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BoundedFetchError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('honours a signal passed in init', async () => {
    const ac = new AbortController();
    const p = boundedFetch('https://x', { signal: ac.signal }, {
      timeoutMs: 5_000, maxBytes: 10,
      fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch,
    }).catch((e) => e);
    ac.abort();
    expect((await p).code).toBe('NETWORK');
  });

  it('readBoundedText cancels the locked stream on timeout', async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const err = await readBoundedText(new Response(stream), { timeoutMs: 20, maxBytes: 10 }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });
});
