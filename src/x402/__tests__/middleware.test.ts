import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createX402Fetch, wrapWithX402 } from '../middleware.js';

type RecordedRequest = {
  method: string;
  path: string;
  body: string;
  paymentHeader: string | undefined;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

const wallet = {} as any;
const recorded: RecordedRequest[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  recorded.length = 0;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

async function startRecorder(
  respond: (req: RecordedRequest, res: ServerResponse) => void,
): Promise<string> {
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const entry: RecordedRequest = {
      method: req.method ?? '',
      path: req.url ?? '',
      body,
      paymentHeader: req.headers['x-payment'] as string | undefined,
    };
    recorded.push(entry);
    respond(entry, res);
  });
  servers.push(server);
  return url;
}

describe('createX402Fetch', () => {
  it('forwards Request method and JSON body instead of collapsing to GET', async () => {
    const origin = await startRecorder((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const payload = JSON.stringify({ order: 'abc', qty: 2 });
    const x402Fetch = createX402Fetch(wallet, { autoPay: false });
    const response = await x402Fetch(
      new Request(`${origin}/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(recorded).toEqual([
      {
        method: 'POST',
        path: '/purchase',
        body: payload,
        paymentHeader: undefined,
      },
    ]);
  });

  it('still forwards string URL + init POST bodies', async () => {
    const origin = await startRecorder((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const payload = JSON.stringify({ task: 'run' });
    const x402Fetch = createX402Fetch(wallet, { autoPay: false });
    const response = await x402Fetch(`${origin}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(recorded[0]).toMatchObject({ method: 'POST', path: '/jobs', body: payload });
  });
});

describe('wrapWithX402', () => {
  it('forwards Request POST body through the wrapped fetch', async () => {
    const origin = await startRecorder((_req, res) => {
      res.statusCode = 200;
      res.end('wrapped');
    });

    const payload = JSON.stringify({ refill: true });
    const wrapped = wrapWithX402(globalThis.fetch, wallet, { autoPay: false });
    const response = await wrapped(
      new Request(`${origin}/refill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('wrapped');
    expect(recorded).toEqual([
      {
        method: 'POST',
        path: '/refill',
        body: payload,
        paymentHeader: undefined,
      },
    ]);
  });

  it('returns the original POST 402 without issuing a follow-up GET', async () => {
    const origin = await startRecorder((_req, res) => {
      res.statusCode = 402;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Payment Required' }));
    });

    const payload = JSON.stringify({ debit: '1.00' });
    const wrapped = wrapWithX402(globalThis.fetch, wallet, { autoPay: false });
    const response = await wrapped(
      new Request(`${origin}/debit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    );

    expect(response.status).toBe(402);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: 'POST',
      path: '/debit',
      body: payload,
    });
  });
});
