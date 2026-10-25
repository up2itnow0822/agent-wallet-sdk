import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as viem from 'viem';
import { baseSepolia } from 'viem/chains';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX_HASH = `0x${'aa'.repeat(32)}`;

interface Request {
  body: Record<string, unknown>;
  params: Record<string, string>;
}
interface Response {
  statusCode: number;
  payload?: Record<string, unknown>;
  status(code: number): Response;
  json(body: Record<string, unknown>): Response;
}
type Handler = (req: Request, res: Response) => unknown;

function loadServer() {
  const routes = new Map<string, Handler>();
  const listen = vi.fn();
  const app = {
    use: vi.fn(),
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => routes.set(`POST ${path}`, handler),
    listen,
  };
  const express = Object.assign(() => app, { json: vi.fn() });
  const writeContract = vi.fn(async () => `0x${'bb'.repeat(32)}`);
  const createWalletClient = vi.fn(() => ({ writeContract }));
  const privateKeyToAccount = vi.fn(() => ({ address: RECIPIENT }));
  const getChainId = vi.fn(async () => 84532);
  const getTransactionReceipt = vi.fn(async () => ({
    status: 'success', blockNumber: 1n, blockHash: TX_HASH, gasUsed: 21_000n,
    logs: [{
      address: TOKEN,
      topics: viem.encodeEventTopics({
        abi: viem.parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']),
        eventName: 'Transfer', args: { from: SENDER, to: RECIPIENT },
      }),
      data: viem.encodeAbiParameters(viem.parseAbiParameters('uint256'), [100_000n]),
    }],
  }));
  const client = { getChainId, getTransactionReceipt, readContract: vi.fn(async () => 1_000_000n) };

  // Load the real example handlers while replacing optional HTTP/env and chain
  // dependencies. Tests never install example dependencies or contact a chain.
  const source = readFileSync(new URL('../examples/settlement-test/server.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const requireDependency = (name: string) => {
    if (name === 'express') return express;
    if (name === 'dotenv') return { config: vi.fn() };
    if (name === 'viem') return { ...viem, createPublicClient: () => client, createWalletClient };
    if (name === 'viem/accounts') return { privateKeyToAccount };
    if (name === 'viem/chains') return { baseSepolia };
    throw new Error(`Unexpected example dependency: ${name}`);
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', compiled)(
    requireDependency, module, module.exports,
    { env: { PRIVATE_KEY: `0x${'01'.repeat(32)}`, PORT: '3402' }, exit: vi.fn() },
  );

  async function request(method: string, path: string, body = {}, params = {}) {
    const response: Response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`Missing route: ${method} ${path}`);
    await handler({ body, params }, response);
    return response;
  }
  return { request, listen, createWalletClient, privateKeyToAccount, writeContract, getChainId, getTransactionReceipt };
}

describe('settlement example safety', () => {
  it('does not construct a signer in the self-test even when a private key is present', async () => {
    const source = readFileSync(new URL('../examples/settlement-test/self-test.ts', import.meta.url), 'utf8');
    // Invoke the real main function explicitly so the read-only offline probe is awaitable.
    const compiled = ts.transpileModule(source.replace(/main\(\)\.catch\(console\.error\);?\s*$/, ''), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const createWalletClient = vi.fn(() => ({}));
    const privateKeyToAccount = vi.fn(() => ({ address: RECIPIENT }));
    const requireDependency = (name: string) => {
      if (name === 'dotenv') return { config: vi.fn() };
      if (name === 'viem/accounts') return { privateKeyToAccount };
      if (name === 'viem/chains') return { baseSepolia };
      if (name === 'viem') return {
        ...viem, createWalletClient,
        createPublicClient: () => ({ readContract: async () => 1_000_000n }),
      };
      throw new Error(`Unexpected self-test dependency: ${name}`);
    };
    const module = { exports: {} };
    const offlineFetch = vi.fn(async () => { throw new Error('offline probe'); });
    const quietConsole = { log: vi.fn(), error: vi.fn() };
    const run = new Function('require', 'module', 'exports', 'fetch', 'console', 'process', `${compiled}\nreturn main;`)(
      requireDependency, module, module.exports, offlineFetch, quietConsole,
      { env: { PRIVATE_KEY: `0x${'01'.repeat(32)}` }, exit: vi.fn() },
    ) as () => Promise<void>;
    await run().catch(() => undefined);
    expect(createWalletClient).not.toHaveBeenCalled();
    expect(privateKeyToAccount).not.toHaveBeenCalled();
  });

  it('rejects settlement submissions until durable challenge storage exists', async () => {
    const { request, writeContract } = loadServer();
    const response = await request('POST', '/settle', { amount: '0.10', from: SENDER });
    expect(response.statusCode).toBe(503);
    expect(response.payload).toMatchObject({ settlementEnabled: false });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('cannot replay a public receipt to trigger outgoing fee transfers', async () => {
    const { request, writeContract, getTransactionReceipt } = loadServer();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('POST', '/settle', { amount: '0.10', from: SENDER, paymentTxHash: TX_HASH });
      expect(response.statusCode).toBe(503);
    }
    expect(writeContract).not.toHaveBeenCalled();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('never creates a signing account or wallet client', () => {
    const { createWalletClient, privateKeyToAccount } = loadServer();
    expect(createWalletClient).not.toHaveBeenCalled();
    expect(privateKeyToAccount).not.toHaveBeenCalled();
  });

  it('listens only on the local loopback address', () => {
    const { listen } = loadServer();
    expect(listen.mock.calls[0][1]).toBe('127.0.0.1');
  });

  it('describes receipt inspection without claiming settlement authorization', async () => {
    const { request } = loadServer();
    const response = await request('GET', '/attestation/:txHash', {}, { txHash: TX_HASH });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ status: 'success', paymentAuthorized: false, settlementEnabled: false });
    expect(response.payload?.verified).not.toBe(true);
  });

  it('rejects malformed receipt hashes before querying RPC', async () => {
    const { request, getTransactionReceipt } = loadServer();
    const response = await request('GET', '/attestation/:txHash', {}, { txHash: '0x1234' });
    expect(response.statusCode).toBe(400);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects a receipt RPC configured for a non-testnet chain', async () => {
    const { request, getChainId, getTransactionReceipt } = loadServer();
    getChainId.mockResolvedValueOnce(8453);
    const response = await request('GET', '/attestation/:txHash', {}, { txHash: TX_HASH });
    expect(response.statusCode).toBe(503);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });
});
