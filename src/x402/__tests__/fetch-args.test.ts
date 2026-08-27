import { describe, expect, it } from 'vitest';
import { toReplayableFetchArgs } from '../fetch-args.js';

describe('toReplayableFetchArgs', () => {
  it('passes through string URL + string body without rewriting', async () => {
    const init: RequestInit = { method: 'POST', body: '{"ok":true}' };
    const result = await toReplayableFetchArgs('https://api.example.com/run', init);
    expect(result.url).toBe('https://api.example.com/run');
    expect(result.init).toBe(init);
  });

  it('copies method, headers, and body off a Request', async () => {
    const payload = JSON.stringify({ action: 'purchase', qty: 2 });
    const request = new Request('https://paid.example.com/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': 'wallet' },
      body: payload,
    });

    const result = await toReplayableFetchArgs(request);

    expect(result.url).toBe('https://paid.example.com/orders');
    expect(result.init?.method).toBe('POST');
    const headers = new Headers(result.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-agent')).toBe('wallet');
    expect(new TextDecoder().decode(result.init?.body as ArrayBuffer)).toBe(payload);
  });

  it('lets explicit init override Request method and body', async () => {
    const request = new Request('https://paid.example.com/orders', {
      method: 'POST',
      body: '{"from":"request"}',
    });

    const result = await toReplayableFetchArgs(request, {
      method: 'PUT',
      body: '{"from":"init"}',
    });

    expect(result.init?.method).toBe('PUT');
    expect(new TextDecoder().decode(result.init?.body as ArrayBuffer)).toBe('{"from":"init"}');
  });

  it('buffers a ReadableStream body so it can be sent twice', async () => {
    const payload = '{"streamed":true}';
    const stream = new Blob([payload]).stream();
    const result = await toReplayableFetchArgs('https://paid.example.com/run', {
      method: 'POST',
      body: stream,
    });

    expect(result.init?.method).toBe('POST');
    expect(new TextDecoder().decode(result.init?.body as ArrayBuffer)).toBe(payload);
  });
});
