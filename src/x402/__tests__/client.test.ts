// [MAX-ADDED] Tests for x402 Client — protocol parsing and payment selection
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  X402Client,
  buildX402PaymentIdempotencyKey,
  canonicalizeX402Amount,
  canonicalizeX402RequestUrl,
  X402_SETTLEMENT_CACHE_LIMIT,
  X402_SETTLEMENT_RETRY_WINDOW_MS,
} from '../client.js';
import { USDC_ADDRESSES } from '../types.js';
import type { X402PaymentRequired, X402PaymentRequirements } from '../types.js';

// Mock wallet (we test protocol logic, not on-chain execution)
const mockWallet = {} as any;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('X402Client', () => {
  describe('parse402Response', () => {
    it('parses base64 PAYMENT-REQUIRED header', async () => {
      const client = new X402Client(mockWallet, { autoPay: false });
      const paymentRequired: X402PaymentRequired = {
        x402Version: 1,
        resource: { url: '/api/data', description: 'Data API', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000',
            payTo: '0xRecipient',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };

      const b64 = btoa(JSON.stringify(paymentRequired));
      const response = new Response(null, {
        status: 402,
        headers: { 'payment-required': b64 },
      });

      const parsed = await client.parse402Response(response);
      expect(parsed).not.toBeNull();
      expect(parsed!.x402Version).toBe(1);
      expect(parsed!.accepts).toHaveLength(1);
      expect(parsed!.accepts[0].scheme).toBe('exact');
      expect(parsed!.accepts[0].amount).toBe('1000000');
    });

    it('parses JSON body fallback', async () => {
      const client = new X402Client(mockWallet, { autoPay: false });
      const paymentRequired: X402PaymentRequired = {
        x402Version: 1,
        resource: { url: '/api/data', description: 'Data', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '500000',
            payTo: '0xRecipient',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };

      const response = new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });

      const parsed = await client.parse402Response(response);
      expect(parsed).not.toBeNull();
      expect(parsed!.accepts[0].amount).toBe('500000');
    });


    it('rejects malformed header payloads before payment selection', async () => {
      const client = new X402Client(mockWallet, { autoPay: false });
      const malformed = {
        x402Version: 1,
        resource: { url: '/api/data', description: 'Data', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '-1000000',
            payTo: '0xRecipient',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };

      const response = new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(malformed)) },
      });

      await expect(client.parse402Response(response)).resolves.toBeNull();
    });

    it('does not pay when the 402 resource is bound to a different path', async () => {
      const client = new X402Client(mockWallet);
      const paymentRequired: X402PaymentRequired = {
        x402Version: 1,
        resource: { url: '/premium/other', description: 'Other API', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000',
            payTo: '0x1111111111111111111111111111111111111111',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };
      const challenged = new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired)) },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(challenged);

      const result = await client.fetch('https://api.example.com/premium/data');

      expect(result).toBe(challenged);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('selectPaymentOption', () => {
    it('selects Base USDC exact scheme when base is in supported networks', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'ethereum:1', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
        { scheme: 'exact', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected).not.toBeNull();
      expect(selected!.network).toBe('base:8453');
    });

    it('selects Arbitrum USDC when configured for arbitrum', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['arbitrum:42161'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
        { scheme: 'exact', network: 'arbitrum:42161', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected).not.toBeNull();
      expect(selected!.network).toBe('arbitrum:42161');
    });

    it('selects Optimism USDC when configured for optimism', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['optimism:10'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'optimism:10', asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', amount: '2000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected).not.toBeNull();
      expect(selected!.network).toBe('optimism:10');
    });

    it('selects Polygon USDC when configured for polygon', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['polygon:137'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'polygon:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', amount: '500000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected).not.toBeNull();
      expect(selected!.network).toBe('polygon:137');
    });

    it('selects any supported network when multi-chain configured', () => {
      const client = new X402Client(mockWallet, {
        supportedNetworks: ['base:8453', 'ethereum:1', 'arbitrum:42161'],
      });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'arbitrum:42161', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected).not.toBeNull();
      expect(selected!.network).toBe('arbitrum:42161');
    });

    it('prefers lowest amount among compatible options', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '5000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
        { scheme: 'exact', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected!.amount).toBe('1000000');
    });

    it('returns null when no compatible option exists', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'solana:mainnet', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1000000', payTo: 'sol_addr', maxTimeoutSeconds: 30, extra: {} },
      ];

      expect(client.selectPaymentOption(accepts)).toBeNull();
    });

    it('returns null when network matches but asset is not supported USDC', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'exact', network: 'base:8453', asset: '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      // Asset is not the known USDC address — should be rejected
      expect(client.selectPaymentOption(accepts)).toBeNull();
    });

    it('prefers exact scheme over others', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'upto', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '500000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
        { scheme: 'exact', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      const selected = client.selectPaymentOption(accepts);
      expect(selected!.scheme).toBe('exact');
    });
  });
});

// ─── USDC_ADDRESSES coverage tests ───
describe('USDC_ADDRESSES multi-chain coverage', () => {
  it('covers all 10 mainnet chains', () => {
    const mainnetChains = [
      'base:8453',
      'ethereum:1',
      'arbitrum:42161',
      'polygon:137',
      'optimism:10',
      'avalanche:43114',
      'unichain:130',
      'linea:59144',
      'sonic:146',
      'worldchain:480',
    ];
    for (const chain of mainnetChains) {
      expect(USDC_ADDRESSES[chain]).toBeDefined();
      expect(USDC_ADDRESSES[chain]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('includes base-sepolia testnet', () => {
    expect(USDC_ADDRESSES['base-sepolia:84532']).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });
});

describe('X402Client retry idempotency', () => {
  const txHash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const payTo = '0x1111111111111111111111111111111111111111';
  const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const url = 'https://api.example.com/premium/data';

  function paymentRequired() {
    return {
      x402Version: 1,
      resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'base:8453',
          asset,
          amount: '1000000',
          payTo,
          maxTimeoutSeconds: 30,
          extra: { nonce: 'intent-1' },
        },
      ],
    };
  }

  function mock402ThenPaid() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired())) },
      });
    });
  }

  it('builds the same settlement key for equivalent URL and asset forms', () => {
    const reqAddress: X402PaymentRequirements = {
      scheme: 'exact',
      network: 'base:8453',
      asset,
      amount: '1000000',
      payTo,
      maxTimeoutSeconds: 30,
      extra: { nonce: 'intent-1' },
    };
    const reqSymbol = { ...reqAddress, asset: 'USDC' };

    expect(
      buildX402PaymentIdempotencyKey('GET', 'https://api.example.com', reqAddress),
    ).toBe(
      buildX402PaymentIdempotencyKey('GET', new URL('https://api.example.com'), reqSymbol),
    );
    expect(canonicalizeX402RequestUrl('https://api.example.com/premium/data#retry'))
      .toBe(canonicalizeX402RequestUrl('https://api.example.com/premium/data'));
    expect(canonicalizeX402Amount('01000000')).toBe('1000000');
    expect(
      buildX402PaymentIdempotencyKey(
        'POST',
        'https://api.example.com/premium/data#retry',
        { ...reqAddress, amount: '01000000' },
      ),
    ).toBe(
      buildX402PaymentIdempotencyKey('POST', url, reqAddress),
    );
  });

  it('replays equivalent URL and asset representations instead of transferring twice', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    let challenges = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      challenges += 1;
      return new Response(null, {
        status: 402,
        headers: {
          'payment-required': btoa(JSON.stringify({
            x402Version: 1,
            resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'exact',
                network: 'base:8453',
                asset: challenges === 1 ? asset : 'USDC',
                amount: '1000000',
                payTo,
                maxTimeoutSeconds: 30,
                extra: { nonce: 'intent-1' },
              },
            ],
          })),
        },
      });
    });
    const client = new X402Client(mockWallet);

    const first = await client.fetch(url, { method: 'POST' });
    const second = await client.fetch(new URL(url), { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(true);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
  });

  it('replays equivalent URL fragments and amount encodings instead of transferring twice', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    let challenges = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      challenges += 1;
      return new Response(null, {
        status: 402,
        headers: {
          'payment-required': btoa(JSON.stringify({
            x402Version: 1,
            resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'exact',
                network: 'base:8453',
                asset,
                amount: challenges === 1 ? '01000000' : '1000000',
                payTo,
                maxTimeoutSeconds: 30,
                extra: { nonce: 'intent-1' },
              },
            ],
          })),
        },
      });
    });
    const client = new X402Client(mockWallet);

    const first = await client.fetch(`${url}#retry`, { method: 'POST' });
    const second = await client.fetch(url, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(true);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
  });

  it('replays the same settlement instead of transferring twice', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const completions: Array<{ replayed?: boolean; idempotencyKey?: string }> = [];
    mock402ThenPaid();
    const client = new X402Client(mockWallet, {
      onPaymentComplete: (log) => completions.push(log),
    });

    const first = await client.fetch(url, { method: 'POST' });
    const second = await client.fetch(url, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].idempotencyKey).toBe(
      buildX402PaymentIdempotencyKey('POST', url, paymentRequired().accepts[0]),
    );
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(true);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
    expect(completions).toHaveLength(2);
    expect(completions[0].replayed).toBe(false);
    expect(completions[1].replayed).toBe(true);
    expect(completions[0].idempotencyKey).toBe(completions[1].idempotencyKey);
  });

  it('keeps concurrent retries on one in-flight settlement', async () => {
    let release: (value: { txHash: `0x${string}` }) => void = () => {};
    const gate = new Promise<{ txHash: `0x${string}` }>((resolve) => {
      release = resolve;
    });
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockReturnValue(gate);
    mock402ThenPaid();
    const client = new X402Client(mockWallet);

    const pending = Promise.all([
      client.fetch(url, { method: 'POST' }),
      client.fetch(url, { method: 'POST' }),
    ]);
    release({ txHash });
    const responses = await pending;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed).length).toBe(1);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
  });

  it('does not reuse settlement across independent calls without an explicit intent', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const approvals: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      return new Response(null, {
        status: 402,
        headers: {
          'payment-required': btoa(JSON.stringify({
            x402Version: 1,
            resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'exact',
                network: 'base:8453',
                asset,
                amount: '1000000',
                payTo,
                maxTimeoutSeconds: 30,
                extra: {},
              },
            ],
          })),
        },
      });
    });
    const client = new X402Client(mockWallet, {
      onBeforePayment: async () => {
        approvals.push('checked');
        return true;
      },
    });

    const first = await client.fetch(url, { method: 'POST', body: JSON.stringify({ a: 1 }) });
    const second = await client.fetch(url, { method: 'POST', body: JSON.stringify({ a: 2 }) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(approvals).toEqual(['checked', 'checked']);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(false);
    expect(logs[0].idempotencyKey).not.toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(2000000n);
  });

  it('expires a successful settlement after the retry window',
    async () => {
      vi.useFakeTimers();
      const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
        .mockResolvedValue({ txHash });
      mock402ThenPaid();
      const client = new X402Client(mockWallet);

      expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
      vi.advanceTimersByTime(X402_SETTLEMENT_RETRY_WINDOW_MS + 1);
      expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);

      expect(executeSpy).toHaveBeenCalledTimes(2);
      const logs = client.getTransactionLog();
      expect(logs).toHaveLength(2);
      expect(logs[0].replayed).toBe(false);
      expect(logs[1].replayed).toBe(false);
      expect(client.getDailySpendSummary().global).toBe(2000000n);
    },
  );

  it('rechecks policy when an expired settlement is removed before reuse', async () => {
    vi.useFakeTimers();
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const approvals: string[] = [];
    mock402ThenPaid();
    const client = new X402Client(mockWallet, {
      globalDailyLimit: 1000000n,
      onBeforePayment: async () => {
        approvals.push('checked');
        return true;
      },
    });

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(approvals).toEqual(['checked']);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const originalSettle = (client as any).settlePayment.bind(client);
    vi.spyOn(client as any, 'settlePayment').mockImplementation(async (...args: unknown[]) => {
      vi.advanceTimersByTime(X402_SETTLEMENT_RETRY_WINDOW_MS + 1);
      return originalSettle(...args);
    });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/global daily limit/);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(approvals).toEqual(['checked']);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1000000n);
  });

  it('evicts the oldest completed settlement once the cache is full',
    async () => {
      const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
        .mockResolvedValue({ txHash });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('X-PAYMENT')) {
          return new Response('paid', { status: 200 });
        }
        const requested = String(input);
        const nonce = new URL(requested).searchParams.get('n') ?? 'missing';
        return new Response(null, {
          status: 402,
          headers: {
            'payment-required': btoa(JSON.stringify({
              x402Version: 1,
              resource: {
                url: new URL(requested).pathname,
                description: 'Data API',
                mimeType: 'application/json',
              },
              accepts: [
                {
                  scheme: 'exact',
                  network: 'base:8453',
                  asset,
                  amount: '1000000',
                  payTo,
                  maxTimeoutSeconds: 30,
                  extra: { nonce },
                },
              ],
            })),
          },
        });
      });
      const client = new X402Client(mockWallet);
      const firstUrl = `${url}?n=intent-0`;

      for (let i = 0; i <= X402_SETTLEMENT_CACHE_LIMIT; i++) {
        const response = await client.fetch(`${url}?n=intent-${i}`, { method: 'POST' });
        expect(response.status).toBe(200);
      }

      const overflowCalls = executeSpy.mock.calls.length;
      expect(overflowCalls).toBe(X402_SETTLEMENT_CACHE_LIMIT + 1);

      const replayAfterEviction = await client.fetch(firstUrl, { method: 'POST' });
      expect(replayAfterEviction.status).toBe(200);
      expect(executeSpy).toHaveBeenCalledTimes(overflowCalls + 1);
    },
  );

  it('does not evict a completed settlement because in-flight entries exceed the cache limit',
    async () => {
      const releases = new Map<string, (value: { txHash: `0x${string}` }) => void>();
      const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
        .mockImplementation(async (selected: { extra?: { nonce?: string } }) => {
          const nonce = String(selected.extra?.nonce ?? '');
          return new Promise<{ txHash: `0x${string}` }>((resolve) => {
            releases.set(nonce, resolve);
          });
        });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('X-PAYMENT')) {
          return new Response('paid', { status: 200 });
        }
        const requested = String(input);
        const nonce = new URL(requested).searchParams.get('n') ?? 'missing';
        return new Response(null, {
          status: 402,
          headers: {
            'payment-required': btoa(JSON.stringify({
              x402Version: 1,
              resource: {
                url: new URL(requested).pathname,
                description: 'Data API',
                mimeType: 'application/json',
              },
              accepts: [
                {
                  scheme: 'exact',
                  network: 'base:8453',
                  asset,
                  amount: '1000000',
                  payTo,
                  maxTimeoutSeconds: 30,
                  extra: { nonce },
                },
              ],
            })),
          },
        });
      });
      const client = new X402Client(mockWallet);
      const firstUrl = `${url}?n=intent-0`;
      const inflight = X402_SETTLEMENT_CACHE_LIMIT + 1;
      const pending = Array.from({ length: inflight }, (_, i) => (
        client.fetch(`${url}?n=intent-${i}`, { method: 'POST' })
      ));

      await vi.waitFor(() => {
        expect(releases.size).toBe(inflight);
      });
      const releaseFirst = releases.get('intent-0');
      expect(releaseFirst).toBeTypeOf('function');
      releaseFirst!({ txHash });
      expect((await pending[0]).status).toBe(200);

      const replay = await client.fetch(firstUrl, { method: 'POST' });
      expect(replay.status).toBe(200);
      expect(executeSpy).toHaveBeenCalledTimes(inflight);
      expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(1);

      for (const [nonce, release] of releases) {
        if (nonce !== 'intent-0') {
          release({ txHash });
        }
      }
      const remaining = await Promise.all(pending.slice(1));
      expect(remaining.every((response) => response.status === 200)).toBe(true);
    },
  );
});

