// [MAX-ADDED] Tests for x402 Client — protocol parsing and payment selection
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  X402Client,
  X402BudgetExceededError,
  X402IntentTermsConflictError,
  X402PaymentError,
  X402SettlementRevertedError,
  X402SettlementQueuedError,
  X402SettlementUnknownError,
  buildX402PaymentIdempotencyKey,
  buildX402PaymentIntentKey,
  buildUnkeyedPendingKey,
  canonicalizeX402Amount,
  canonicalizeX402RequestUrl,
  fingerprintX402RequestHeaders,
  fingerprintReadableX402RequestBody,
  x402SettlementReceiptIsQueued,
  X402_MAX_UNCONFIRMED_SETTLEMENTS,
  X402_RECONFIRM_BACKOFF_MS,
  X402_SETTLEMENT_RETRY_WINDOW_MS,
  X402_TRANSACTION_QUEUED_TOPIC,
  X402SettlementBacklogError,
} from '../client.js';
import { USDC_ADDRESSES } from '../types.js';
import type { X402PaymentRequired, X402PaymentRequirements } from '../types.js';

type X402ClientPaymentInternals = {
  executePayment: (...args: unknown[]) => Promise<{ txHash: `0x${string}` }>;
};

// Mock wallet (we test protocol logic, not on-chain execution).
// Settlements stay in-flight until publicClient confirms the receipt.
const mockWallet = {
  publicClient: {
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  },
} as any;

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

    it('does not pay when fetch follows a cross-origin redirect to a 402', async () => {
      const client = new X402Client(mockWallet);
      const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment');
      const paymentRequired: X402PaymentRequired = {
        x402Version: 1,
        // Relative path matches the original request — binding against the
        // original URL alone would incorrectly authorize payment to the attacker.
        resource: { url: '/premium/data', description: 'Data API', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '1000000',
            payTo: '0x2222222222222222222222222222222222222222',
            maxTimeoutSeconds: 30,
            extra: {},
          },
        ],
      };
      const challenged = new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired)) },
      });
      Object.defineProperty(challenged, 'url', {
        value: 'https://evil.example.com/premium/data',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(challenged);

      const result = await client.fetch('https://api.example.com/premium/data');

      expect(result).toBe(challenged);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
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

    it('refuses upto-only offers instead of transferring the authorization cap', () => {
      const client = new X402Client(mockWallet, { supportedNetworks: ['base:8453'] });
      const accepts: X402PaymentRequirements[] = [
        { scheme: 'upto', network: 'base:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000000', payTo: '0x1', maxTimeoutSeconds: 30, extra: {} },
      ];

      expect(client.selectPaymentOption(accepts)).toBeNull();
    });
  });

  describe('upto scheme auto-pay', () => {
    it('does not pay when the 402 only offers an upto authorization', async () => {
      const client = new X402Client(mockWallet);
      const paymentRequired: X402PaymentRequired = {
        x402Version: 1,
        resource: { url: '/premium/data', description: 'Usage API', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'upto',
            network: 'base:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '10000000',
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
      const executeSpy = vi.spyOn(
        X402Client.prototype as unknown as X402ClientPaymentInternals,
        'executePayment',
      );

      const result = await client.fetch('https://api.example.com/premium/data');

      expect(result).toBe(challenged);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('fails closed if executePayment is invoked with a non-exact scheme', async () => {
      const client = new X402Client(mockWallet);
      const req: X402PaymentRequirements = {
        scheme: 'upto',
        network: 'base:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '10000000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 30,
        extra: {},
      };

      await expect(
        (client as unknown as X402ClientPaymentInternals).executePayment(req),
      ).rejects.toBeInstanceOf(X402PaymentError);
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

  it('retries a Request POST with the original body after paying', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const payload = JSON.stringify({ sku: 'alpha', qty: 2 });
    const hops: Array<{ method?: string; body: string; paid: boolean }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const rawBody = init?.body;
      const body = typeof rawBody === 'string'
        ? rawBody
        : rawBody instanceof ArrayBuffer
          ? new TextDecoder().decode(rawBody)
          : ArrayBuffer.isView(rawBody)
            ? new TextDecoder().decode(rawBody)
            : '';
      hops.push({ method: init?.method, body, paid: headers.has('X-PAYMENT') });
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired())) },
      });
    });
    const client = new X402Client(mockWallet);

    const result = await client.fetch(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }));

    expect(result.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(hops).toHaveLength(2);
    expect(hops[0]).toMatchObject({ method: 'POST', body: payload, paid: false });
    expect(hops[1]).toMatchObject({ method: 'POST', body: payload, paid: true });
  });

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
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
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
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
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
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
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
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('single-flights onBeforePayment and execute for concurrent same-intent retries', async () => {
    let releasePolicy: (value: boolean) => void = () => {};
    const policyGate = new Promise<boolean>((resolve) => {
      releasePolicy = resolve;
    });
    let release: (value: { txHash: `0x${string}` }) => void = () => {};
    const gate = new Promise<{ txHash: `0x${string}` }>((resolve) => {
      release = resolve;
    });
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockReturnValue(gate);
    const approvals: string[] = [];
    mock402ThenPaid();
    const client = new X402Client(mockWallet, {
      onBeforePayment: async () => {
        approvals.push('checked');
        return policyGate;
      },
    });

    const pending = Promise.all([
      client.fetch(url, { method: 'POST' }),
      client.fetch(url, { method: 'POST' }),
    ]);
    await vi.waitFor(() => {
      expect(approvals).toEqual(['checked']);
    });
    expect(executeSpy).toHaveBeenCalledTimes(0);
    releasePolicy(true);
    await vi.waitFor(() => {
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
    release({ txHash });
    const responses = await pending;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(approvals).toEqual(['checked']);
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('does not reuse settlement across independent calls without an explicit intent', async () => {
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
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
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('keeps concurrent unkeyed fetches on one in-flight settlement', async () => {
    let releasePolicy: (value: boolean) => void = () => {};
    const policyGate = new Promise<boolean>((resolve) => {
      releasePolicy = resolve;
    });
    let release: (value: { txHash: `0x${string}` }) => void = () => {};
    const gate = new Promise<{ txHash: `0x${string}` }>((resolve) => {
      release = resolve;
    });
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockReturnValue(gate);
    const approvals: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, {
      globalDailyLimit: 1_007_700n,
      onBeforePayment: async () => {
        approvals.push('checked');
        return policyGate;
      },
    });

    const pending = Promise.all([
      client.fetch(url, { method: 'POST' }),
      client.fetch(url, { method: 'POST' }),
    ]);
    await vi.waitFor(() => {
      expect(approvals).toEqual(['checked']);
    });
    expect(executeSpy).toHaveBeenCalledTimes(0);
    releasePolicy(true);
    await vi.waitFor(() => {
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
    release({ txHash });
    const responses = await pending;

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(approvals).toEqual(['checked']);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed).length).toBe(1);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('does not transfer again when an unkeyed receipt is still pending', async () => {
    let releaseReceipt: (value: { status: string }) => void = () => {};
    const receiptGate = new Promise<{ status: string }>((resolve) => {
      releaseReceipt = resolve;
    });
    const waitReceipt = vi.fn(() => receiptGate);
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    const first = client.fetch(url, { method: 'POST' });
    await vi.waitFor(() => {
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(waitReceipt).toHaveBeenCalledTimes(1);
    });

    const second = client.fetch(url, { method: 'POST' });
    await vi.waitFor(() => {
      expect(waitReceipt).toHaveBeenCalledTimes(1);
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);

    releaseReceipt({ status: 'success' });
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed).length).toBe(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('does not coalesce concurrent unkeyed POSTs with different bodies', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });

    const responses = await Promise.all([
      client.fetch(url, { method: 'POST', body: JSON.stringify({ sku: 'alpha' }) }),
      client.fetch(url, { method: 'POST', body: JSON.stringify({ sku: 'beta' }) }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.replayed === false)).toBe(true);
    expect(logs[0].idempotencyKey).not.toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('single-flights concurrent unkeyed POSTs that share a body', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 1_007_700n });
    const body = JSON.stringify({ sku: 'alpha' });

    const responses = await Promise.all([
      client.fetch(url, { method: 'POST', body }),
      client.fetch(url, { method: 'POST', body }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed).length).toBe(1);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('single-flights concurrent unkeyed POSTs sharing a FormData file', async () => {
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    ).mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 1_007_700n });
    const body = new FormData();
    body.append('file', new Blob(['x'], { type: 'text/plain' }), 'proof.txt');

    const responses = await Promise.all([
      client.fetch(url, { method: 'POST', body }),
      client.fetch(url, { method: 'POST', body }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.replayed).length).toBe(1);
    expect(logs[0].idempotencyKey).toBe(logs[1].idempotencyKey);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('does not coalesce same-body unkeyed requests from distinct callers', async () => {
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const body = JSON.stringify({ sku: 'alpha' });

    const responses = await Promise.all([
      client.fetch(url, {
        method: 'POST', body, headers: { Authorization: 'Bearer caller-a', 'Idempotency-Key': 'a' },
      }),
      client.fetch(url, {
        method: 'POST', body, headers: { authorization: 'Bearer caller-b', 'Idempotency-Key': 'b' },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('separates credential contexts while normalizing the default mode', async () => {
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    ).mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const body = JSON.stringify({ sku: 'alpha' });

    const responses = await Promise.all([
      client.fetch(url, { method: 'POST', body }),
      client.fetch(url, { method: 'POST', body, credentials: 'same-origin' }),
      client.fetch(url, { method: 'POST', body, credentials: 'include' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(3);
    expect(logs.filter((log) => log.replayed)).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('scopes unkeyed pending keys to readable request identity', () => {
    const terms = 'terms';
    expect(fingerprintReadableX402RequestBody(undefined)).toBe('');
    expect(fingerprintReadableX402RequestBody('{"sku":"alpha"}'))
      .not.toBe(fingerprintReadableX402RequestBody('{"sku":"beta"}'));
    expect(
      buildUnkeyedPendingKey('POST', url, terms, fingerprintReadableX402RequestBody('{"sku":"alpha"}')!),
    ).not.toBe(
      buildUnkeyedPendingKey('POST', url, terms, fingerprintReadableX402RequestBody('{"sku":"beta"}')!),
    );
    expect(buildUnkeyedPendingKey('POST', url, terms, '')).toBe(
      buildUnkeyedPendingKey('POST', url, terms),
    );
  });

  it('normalizes header identity without retaining caller values in the key', () => {
    const record = fingerprintX402RequestHeaders({
      Authorization: 'Bearer caller-a',
      'Idempotency-Key': 'request-a',
      'X-Tenant': 'tenant-a',
    });
    const tuples = fingerprintX402RequestHeaders([
      ['x-tenant', 'tenant-a'],
      ['idempotency-key', 'request-a'],
      ['authorization', 'Bearer caller-a'],
    ]);
    const distinct = fingerprintX402RequestHeaders({
      Authorization: 'Bearer caller-b',
      'Idempotency-Key': 'request-b',
      'X-Tenant': 'tenant-b',
    });

    expect(record).toBe(tuples);
    expect(record).not.toBe(distinct);
    expect(record).not.toContain('caller-a');
    expect(record).not.toContain('request-a');
  });

  it('snapshots mutable request bodies before the challenged fetch yields', async () => {
    let releaseFirstChallenge: (response: Response) => void = () => {};
    const firstChallenge = new Promise<Response>((resolve) => { releaseFirstChallenge = resolve; });
    let challenges = 0;
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      challenges += 1;
      if (challenges === 1) {
        return firstChallenge;
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const firstBody = new URLSearchParams({ sku: 'alpha' });
    const first = client.fetch(url, { method: 'POST', body: firstBody });
    await vi.waitFor(() => expect(challenges).toBe(1));
    firstBody.set('sku', 'beta');
    const second = client.fetch(url, { method: 'POST', body: new URLSearchParams({ sku: 'beta' }) });
    const unkeyed = paymentRequired();
    delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
    releaseFirstChallenge(new Response(null, {
      status: 402,
      headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
    }));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('snapshots mutable request headers before the challenged fetch yields', async () => {
    let releaseFirstChallenge: (response: Response) => void = () => {};
    const firstChallenge = new Promise<Response>((resolve) => { releaseFirstChallenge = resolve; });
    let challenges = 0;
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      challenges += 1;
      if (challenges === 1) {
        return firstChallenge;
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const headers = new Headers({ Authorization: 'Bearer caller-a' });
    const first = client.fetch(url, { method: 'POST', body: 'same', headers });
    await vi.waitFor(() => expect(challenges).toBe(1));
    headers.set('Authorization', 'Bearer caller-b');
    const second = client.fetch(url, {
      method: 'POST', body: 'same', headers: { Authorization: 'Bearer caller-b' },
    });
    const unkeyed = paymentRequired();
    delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
    releaseFirstChallenge(new Response(null, {
      status: 402,
      headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
    }));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('snapshots a mutable FormData body before the challenged fetch yields', async () => {
    let releaseFirstChallenge: (response: Response) => void = () => {};
    const firstChallenge = new Promise<Response>((resolve) => { releaseFirstChallenge = resolve; });
    let challenges = 0;
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    ).mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) return new Response('paid', { status: 200 });
      challenges += 1;
      if (challenges === 1) return firstChallenge;
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, { status: 402, headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) } });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const firstBody = new FormData();
    firstBody.append('sku', 'alpha');
    const first = client.fetch(url, { method: 'POST', body: firstBody });
    await vi.waitFor(() => expect(challenges).toBe(1));
    firstBody.set('sku', 'beta');
    const secondBody = new FormData();
    secondBody.append('sku', 'beta');
    const second = client.fetch(url, { method: 'POST', body: secondBody });
    const unkeyed = paymentRequired();
    delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
    releaseFirstChallenge(new Response(null, {
      status: 402, headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
    }));

    await Promise.all([first, second]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('snapshots a mutable method before the challenged fetch yields', async () => {
    let releaseFirstChallenge: (response: Response) => void = () => {};
    const firstChallenge = new Promise<Response>((resolve) => { releaseFirstChallenge = resolve; });
    let challenges = 0;
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    ).mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (new Headers(init?.headers).has('X-PAYMENT')) return new Response('paid', { status: 200 });
      challenges += 1;
      if (challenges === 1) return firstChallenge;
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, { status: 402, headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) } });
    });
    const client = new X402Client(mockWallet, { globalDailyLimit: 2_015_400n });
    const firstInit: RequestInit = { method: 'POST', body: 'same' };
    const first = client.fetch(url, firstInit);
    await vi.waitFor(() => expect(challenges).toBe(1));
    firstInit.method = 'PUT';
    const second = client.fetch(url, { method: 'PUT', body: 'same' });
    const unkeyed = paymentRequired();
    delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
    releaseFirstChallenge(new Response(null, {
      status: 402, headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
    }));

    await Promise.all([first, second]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('uses the original request snapshot for the paid retry after caller mutation', async () => {
    let releaseChallenge: (response: Response) => void = () => {};
    const challenge = new Promise<Response>((resolve) => { releaseChallenge = resolve; });
    const observed: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    ).mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = init?.body;
      observed.push({
        url: String(input),
        method: String(init?.method),
        authorization: new Headers(init?.headers).get('authorization'),
        body: body instanceof URLSearchParams ? body.toString() : String(body ?? ''),
      });
      if (!new Headers(init?.headers).has('X-PAYMENT')) return challenge;
      return new Response('paid', { status: 200 });
    });
    const requestUrl = new URL(url);
    const body = new URLSearchParams({ sku: 'alpha' });
    const headers = new Headers({ Authorization: 'Bearer caller-a' });
    const requestInit: RequestInit = { method: 'POST', headers, body };
    const client = new X402Client(mockWallet);
    const pending = client.fetch(requestUrl, requestInit);
    await vi.waitFor(() => expect(observed).toHaveLength(1));

    requestUrl.pathname = '/mutated';
    requestInit.method = 'PUT';
    headers.set('Authorization', 'Bearer caller-b');
    body.set('sku', 'beta');
    const unkeyed = paymentRequired();
    delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
    releaseChallenge(new Response(null, {
      status: 402, headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
    }));

    expect((await pending).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(2);
    expect(observed).toEqual([
      expect.objectContaining({ url, method: 'POST', authorization: 'Bearer caller-a', body: 'sku=alpha' }),
      expect.objectContaining({ url, method: 'POST', authorization: 'Bearer caller-a', body: 'sku=alpha' }),
    ]);
  });

  it('fails closed when the same explicit intent returns different payment terms', async () => {
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
                amount: challenges === 1 ? '1000000' : '2000000',
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

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    await expect(client.fetch(url, { method: 'POST' }))
      .rejects.toBeInstanceOf(X402IntentTermsConflictError);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('settles delimiter-colliding explicit intents separately', async () => {
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
                amount: '1000000',
                payTo,
                maxTimeoutSeconds: 30,
                extra: { nonce: challenges === 1 ? 'c' : 'b|c' },
              },
            ],
          })),
        },
      });
    });
    const client = new X402Client(mockWallet);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(buildX402PaymentIntentKey('POST', url, 'c'))
      .not.toBe(buildX402PaymentIntentKey('POST', url, 'b|c'));
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].replayed).toBe(false);
    expect(logs[1].replayed).toBe(false);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
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
      expect(client.getDailySpendSummary().global).toBe(2_015_400n);
    },
  );

  it('rechecks policy when an expired settlement is removed before reuse', async () => {
    vi.useFakeTimers();
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const approvals: string[] = [];
    mock402ThenPaid();
    const client = new X402Client(mockWallet, {
      globalDailyLimit: 1_007_700n,
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
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('reuses a submitted settlement until the receipt is final', async () => {
    let releaseReceipt: (value: { status: string }) => void = () => {};
    const receiptGate = new Promise<{ status: string }>((resolve) => {
      releaseReceipt = resolve;
    });
    const waitReceipt = vi.fn(() => receiptGate);
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet);

    const firstPromise = client.fetch(url, { method: 'POST' });
    await vi.waitFor(() => {
      expect(waitReceipt).toHaveBeenCalledTimes(1);
    });
    const secondPromise = client.fetch(url, { method: 'POST' });
    releaseReceipt({ status: 'success' });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledWith({
      hash: txHash,
      onReplaced: expect.any(Function),
    });
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('treats a successful AgentAccount queue as unpaid', () => {
    const wallet = '0x2222222222222222222222222222222222222222';
    const queuedReceipt = {
      status: 'success',
      logs: [
        {
          address: wallet,
          topics: [X402_TRANSACTION_QUEUED_TOPIC],
        },
      ],
    };
    expect(x402SettlementReceiptIsQueued(queuedReceipt, wallet)).toBe(true);
    expect(x402SettlementReceiptIsQueued(queuedReceipt, '0x3333333333333333333333333333333333333333')).toBe(false);
    expect(x402SettlementReceiptIsQueued({ status: 'success', logs: [] }, wallet)).toBe(false);
  });

  it('refuses to send X-PAYMENT when the payee transfer only queued', async () => {
    const waitReceipt = vi.fn().mockResolvedValue({
      status: 'success',
      logs: [
        {
          address: '0x2222222222222222222222222222222222222222',
          topics: [X402_TRANSACTION_QUEUED_TOPIC],
        },
      ],
    });
    const wallet = {
      address: '0x2222222222222222222222222222222222222222',
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const fetchSpy = mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(
      fetchSpy.mock.calls.some(([, init]) => new Headers(init?.headers).has('X-PAYMENT')),
    ).toBe(false);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
  });

  it('waits for receipt on unkeyed challenges and fails closed when queued', async () => {
    const waitReceipt = vi.fn().mockResolvedValue({
      status: 'success',
      logs: [
        {
          address: '0x2222222222222222222222222222222222222222',
          topics: [X402_TRANSACTION_QUEUED_TOPIC],
        },
      ],
    });
    const wallet = {
      address: '0x2222222222222222222222222222222222222222',
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(waitReceipt).toHaveBeenCalledWith({
      hash: txHash,
      onReplaced: expect.any(Function),
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
  });

  it('does not reuse an unkeyed hash as proof for a different resource', async () => {
    const firstHash = txHash;
    const secondHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const otherUrl = 'https://api.example.com/premium/other';
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValueOnce({ txHash: firstHash })
      .mockResolvedValueOnce({ txHash: secondHash });
    const paymentHeaders: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      const payment = headers.get('X-PAYMENT');
      if (payment) {
        paymentHeaders.push(payment);
        return new Response('paid', { status: 200 });
      }
      const requested = new URL(String(input));
      const unkeyed = {
        x402Version: 1,
        resource: {
          url: requested.pathname,
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
          },
        ],
      };
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(wallet, { globalDailyLimit: 2_015_400n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/RPC timeout/);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    expect((await client.fetch(otherUrl, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].url).toBe(otherUrl);
    expect(client.getTransactionLog()[0].txHash).toBe(secondHash);
    const retryPayload = JSON.parse(atob(paymentHeaders[0]));
    expect(retryPayload.payload.txHash).toBe(secondHash);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(2);
    expect(client.getTransactionLog()[1].url).toBe(url);
    expect(client.getTransactionLog()[1].txHash).toBe(firstHash);
    const firstResourcePayload = JSON.parse(atob(paymentHeaders[1]));
    expect(firstResourcePayload.payload.txHash).toBe(firstHash);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('does not block an unrelated unkeyed payment after another resource queued', async () => {
    const firstHash = txHash;
    const secondHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const otherUrl = 'https://api.example.com/premium/other';
    const queuedReceipt = {
      status: 'success',
      logs: [
        {
          address: '0x2222222222222222222222222222222222222222',
          topics: [X402_TRANSACTION_QUEUED_TOPIC],
        },
      ],
    };
    const waitReceipt = vi.fn()
      .mockResolvedValueOnce(queuedReceipt)
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      address: '0x2222222222222222222222222222222222222222',
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValueOnce({ txHash: firstHash })
      .mockResolvedValueOnce({ txHash: secondHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const requested = new URL(String(input));
      const unkeyed = {
        x402Version: 1,
        resource: {
          url: requested.pathname,
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
          },
        ],
      };
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(wallet, { globalDailyLimit: 2_015_400n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);

    expect((await client.fetch(otherUrl, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].txHash).toBe(secondHash);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('adopts a repriced settlement hash before sending X-PAYMENT', async () => {
    const repricedHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const paymentHashes: string[] = [];
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      onReplaced?.({
        reason: 'repriced',
        transactionReceipt: { status: 'success', transactionHash: repricedHash },
      });
      return { status: 'success', transactionHash: repricedHash };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const proof = headers.get('X-PAYMENT');
      if (proof) {
        paymentHashes.push(JSON.parse(atob(proof)).payload.txHash);
        return new Response('paid', { status: 200 });
      }
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired())) },
      });
    });
    const client = new X402Client(wallet);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(paymentHashes).toEqual([repricedHash, repricedHash]);
    expect(client.getTransactionLog().map((log) => log.txHash)).toEqual([
      repricedHash,
      repricedHash,
    ]);
    expect(client.getTransactionLog()[1].replayed).toBe(true);
  });

  it('fails closed when a pending settlement is cancelled', async () => {
    const cancelledHash = ('0x' + '11'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      onReplaced?.({
        reason: 'cancelled',
        transactionReceipt: { status: 'success', transactionHash: cancelledHash },
      });
      return { status: 'success', transactionHash: cancelledHash };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const fetchSpy = mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(
      fetchSpy.mock.calls.some(([, init]) => new Headers(init?.headers).has('X-PAYMENT')),
    ).toBe(false);
  });

  it('keeps a replaced settlement reserved so a retry cannot double-pay', async () => {
    const replacedHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      onReplaced?.({
        reason: 'replaced',
        transactionReceipt: { status: 'success', transactionHash: replacedHash },
      });
      return { status: 'success', transactionHash: replacedHash };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    const fetchSpy = mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(
      fetchSpy.mock.calls.some(([, init]) => new Headers(init?.headers).has('X-PAYMENT')),
    ).toBe(false);
    expect(client.getTransactionLog()).toHaveLength(0);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(waitReceipt.mock.calls.every(([arg]) => arg.hash === txHash)).toBe(true);
    expect(waitReceipt.mock.calls.some(([arg]) => arg.hash === replacedHash)).toBe(false);
  });

  it('releases the reservation when a replacement receipt is reverted', async () => {
    const replacedHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      onReplaced?.({
        reason: 'replaced',
        transactionReceipt: { status: 'reverted', transactionHash: replacedHash },
      });
      return { status: 'reverted', transactionHash: replacedHash };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toMatchObject({
      name: 'X402SettlementRevertedError',
      txHash: replacedHash,
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('surfaces a queued replacement as queued instead of unknown', async () => {
    const replacedHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const walletAddress = '0x2222222222222222222222222222222222222222';
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      onReplaced?.({
        reason: 'replaced',
        transactionReceipt: { status: 'success', transactionHash: replacedHash },
      });
      return {
        status: 'success',
        transactionHash: replacedHash,
        logs: [
          {
            address: walletAddress,
            topics: [X402_TRANSACTION_QUEUED_TOPIC],
          },
        ],
      };
    });
    const wallet = {
      address: walletAddress,
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    await expect(client.fetch(url, { method: 'POST' })).rejects.toMatchObject({
      txHash: replacedHash,
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementQueuedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not emit proof when retry confirmation discovers a replacement', async () => {
    const replacedHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    let attempts = 0;
    const waitReceipt = vi.fn(async ({
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary receipt outage');
      }
      onReplaced?.({
        reason: 'replaced',
        transactionReceipt: { status: 'success', transactionHash: replacedHash },
      });
      return { status: 'success', transactionHash: replacedHash };
    });
    const wallet = { publicClient: { waitForTransactionReceipt: waitReceipt } };
    const executeSpy = vi.spyOn(
      X402Client.prototype as unknown as X402ClientPaymentInternals,
      'executePayment',
    )
      .mockResolvedValue({ txHash });
    const fetchSpy = mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('temporary receipt outage');
    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(
      fetchSpy.mock.calls.filter(([, init]) => new Headers(init?.headers).has('X-PAYMENT')),
    ).toHaveLength(0);
  });

  it('keeps a hash-mismatch without onReplaced as unknown so a retry cannot double-pay', async () => {
    const otherHash = ('0x' + '33'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn()
      .mockResolvedValueOnce({
        status: 'success',
        transactionHash: otherHash,
      })
      .mockResolvedValue({
        status: 'success',
        transactionHash: txHash,
      });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(
      'receipt hash mismatch without replacement signal',
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(2);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    expect(client.getTransactionLog().map((log) => log.txHash)).toEqual([txHash]);
    expect(client.getTransactionLog()[0].replayed).toBe(true);
  });

  it('adopts a delayed reprice onto the stored observation so retries cannot report the obsolete hash', async () => {
    const repricedHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockImplementation(async ({
        onReplaced,
      }: {
        hash: string;
        onReplaced?: (event: {
          reason: string;
          transactionReceipt: { status: string; transactionHash: string };
        }) => void;
      }) => {
        onReplaced?.({
          reason: 'repriced',
          transactionReceipt: { status: 'success', transactionHash: repricedHash },
        });
        return { status: 'success', transactionHash: repricedHash };
      });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog().map((log) => log.txHash)).toEqual([repricedHash]);
    expect(client.getTransactionLog()[0].replayed).toBe(true);
  });

  it('keeps the original hash when a success receipt does not rename the transaction', async () => {
    const waitReceipt = vi.fn(async () => ({
      status: 'success',
      transactionHash: txHash,
    }));
    const paymentHashes: string[] = [];
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const proof = headers.get('X-PAYMENT');
      if (proof) {
        paymentHashes.push(JSON.parse(atob(proof)).payload.txHash);
        return new Response('paid', { status: 200 });
      }
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(paymentRequired())) },
      });
    });
    const client = new X402Client(wallet);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(paymentHashes).toEqual([txHash]);
    expect(client.getTransactionLog()[0].txHash).toBe(txHash);
  });

  it('retains an unkeyed broadcast when receipt polling fails so a retry cannot double-pay', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const unkeyed = paymentRequired();
      delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
      });
    });
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/RPC timeout/);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);
    expect(client.getTransactionLog()).toHaveLength(0);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('drops a reverted settlement so a later retry can transfer again', async () => {
    const waitReceipt = vi.fn()
      .mockResolvedValueOnce({ status: 'reverted' })
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/reverted/);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].replayed).toBe(false);
  });

  it('reuses a submitted settlement when receipt polling fails', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog()).toHaveLength(0);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(2);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getTransactionLog()[0].replayed).toBe(true);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('keeps confirming after polling errors and fails closed on a delayed revert', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ status: 'reverted' })
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(1);

    // The delayed revert is surfaced to the caller. The client never starts a
    // second fee+payee transfer on its own after money already moved once.
    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(waitReceipt).toHaveBeenCalledTimes(2);

    // No proof or optimistic log was emitted before finality. The caller's
    // next retry may settle fresh after observing the revert.
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(waitReceipt).toHaveBeenCalledTimes(3);
    const logs = client.getTransactionLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: true, replayed: false });
  });

  it('releases reserved daily budget exactly once when a delayed revert is confirmed', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ status: 'reverted' })
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    // Two concurrent observers of the same delayed revert share one
    // confirmation, so the reservation is released once, not twice.
    const results = await Promise.allSettled([
      client.fetch(url, { method: 'POST' }),
      client.fetch(url, { method: 'POST' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(waitReceipt).toHaveBeenCalledTimes(2);
    expect(client.getDailySpendSummary().global).toBe(0n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(waitReceipt).toHaveBeenCalledTimes(3);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('reconfirms an unknown settlement on unrelated client activity', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    vi.spyOn(X402Client.prototype as any, 'executePayment').mockResolvedValue({ txHash });
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
            resource: { url: new URL(requested).pathname, description: 'Data API', mimeType: 'application/json' },
            accepts: [
              { scheme: 'exact', network: 'base:8453', asset, amount: '1000000', payTo, maxTimeoutSeconds: 30, extra: { nonce } },
            ],
          })),
        },
      });
    });
    const client = new X402Client(wallet);

    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(waitReceipt).toHaveBeenCalledTimes(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    // A different intent triggers reconfirmation of the unknown one.
    expect((await client.fetch(`${url}?n=intent-b`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => {
      expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    });
    expect(waitReceipt).toHaveBeenCalledTimes(3);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('reserves daily budget before receipt confirmation so a second intent cannot overspend', async () => {
    let releaseReceipt: (value: { status: string }) => void = () => {};
    const receiptGate = new Promise<{ status: string }>((resolve) => {
      releaseReceipt = resolve;
    });
    const waitReceipt = vi.fn(() => receiptGate);
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
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
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    const firstPromise = client.fetch(`${url}?n=intent-a`, { method: 'POST' });
    await vi.waitFor(() => {
      expect(waitReceipt).toHaveBeenCalledTimes(1);
    });
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);

    await expect(client.fetch(`${url}?n=intent-b`, { method: 'POST' }))
      .rejects.toThrow(/global daily limit/);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    releaseReceipt({ status: 'success' });
    expect((await firstPromise).status).toBe(200);
    expect(client.getTransactionLog()).toHaveLength(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('releases a reserved budget when the first receipt is a revert', async () => {
    const waitReceipt = vi.fn()
      .mockResolvedValueOnce({ status: 'reverted' })
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(wallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/reverted/);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getDailySpendSummary().global).toBe(0n);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  function mock402PerIntent() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
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
            resource: { url: new URL(requested).pathname, description: 'Data API', mimeType: 'application/json' },
            accepts: [
              { scheme: 'exact', network: 'base:8453', asset, amount: '1000000', payTo, maxTimeoutSeconds: 30, extra: { nonce } },
            ],
          })),
        },
      });
    });
  }

  it('backs off opportunistic reconfirm of a replaced settlement', async () => {
    vi.useFakeTimers();
    const txA = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const txOther = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const replacedHash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({
      hash,
      onReplaced,
    }: {
      hash: string;
      onReplaced?: (event: {
        reason: string;
        transactionReceipt: { status: string; transactionHash: string };
      }) => void;
    }) => {
      if (hash === txA) {
        onReplaced?.({
          reason: 'replaced',
          transactionReceipt: { status: 'success', transactionHash: replacedHash },
        });
        return { status: 'success', transactionHash: replacedHash };
      }
      return { status: 'success' };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockImplementation(async (...args: unknown[]) => {
        const selected = args[0] as { extra?: { nonce?: string } } | undefined;
        return { txHash: selected?.extra?.nonce === 'intent-a' ? txA : txOther };
      });
    mock402PerIntent();
    const client = new X402Client(wallet, { globalDailyLimit: 5000000n });
    const attemptsForA = () => waitReceipt.mock.calls.filter((call) => call[0].hash === txA).length;

    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(attemptsForA()).toBe(1);

    expect((await client.fetch(`${url}?n=intent-b`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(2);

    expect((await client.fetch(`${url}?n=intent-c`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(2);

    vi.advanceTimersByTime(X402_RECONFIRM_BACKOFF_MS + 1);
    expect((await client.fetch(`${url}?n=intent-d`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(3);

    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(attemptsForA()).toBe(4);
  });

  it('reserves budget atomically so concurrent distinct intents cannot both pass one limit', async () => {
    let releasePolicy: (value: boolean) => void = () => {};
    const policyGate = new Promise<boolean>((resolve) => {
      releasePolicy = resolve;
    });
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402PerIntent();
    const client = new X402Client(mockWallet, {
      globalDailyLimit: 1_007_700n,
      onBeforePayment: async () => policyGate,
    });

    const first = client.fetch(`${url}?n=intent-a`, { method: 'POST' });
    const second = client.fetch(`${url}?n=intent-b`, { method: 'POST' });
    releasePolicy(true);
    const results = await Promise.allSettled([first, second]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(X402BudgetExceededError);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('releases the reservation when execution throws before a hash is returned', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue({ txHash });
    mock402ThenPaid();
    const client = new X402Client(mockWallet, { globalDailyLimit: 1_007_700n });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow(/rpc down/);
    expect(client.getDailySpendSummary().global).toBe(0n);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);
  });

  it('retains every completed settlement for the full retry window regardless of count', async () => {
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402PerIntent();
    const client = new X402Client(mockWallet);
    const count = 300;

    for (let i = 0; i < count; i++) {
      expect((await client.fetch(`${url}?n=intent-${i}`, { method: 'POST' })).status).toBe(200);
    }
    expect(executeSpy).toHaveBeenCalledTimes(count);

    // Every intent, including the very first, still replays inside its window.
    for (const i of [0, 1, count - 1]) {
      expect((await client.fetch(`${url}?n=intent-${i}`, { method: 'POST' })).status).toBe(200);
    }
    expect(executeSpy).toHaveBeenCalledTimes(count);
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(3);
  });

  it('emits collision-free idempotency keys for delimiter-containing fields', () => {
    const base: X402PaymentRequirements = {
      scheme: 'a|b',
      network: 'base:8453',
      asset,
      amount: '1000000',
      payTo,
      maxTimeoutSeconds: 30,
      extra: { nonce: 'c' },
    };
    const colliding: X402PaymentRequirements = { ...base, scheme: 'a', extra: { nonce: 'b|c' } };
    expect(buildX402PaymentIdempotencyKey('POST', url, base))
      .not.toBe(buildX402PaymentIdempotencyKey('POST', url, colliding));
  });

  it('pays unkeyed challenges on runtimes without crypto.randomUUID', async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
        .mockResolvedValue({ txHash });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('X-PAYMENT')) {
          return new Response('paid', { status: 200 });
        }
        const unkeyed = paymentRequired();
        delete (unkeyed.accepts[0] as { extra?: unknown }).extra;
        return new Response(null, {
          status: 402,
          headers: { 'payment-required': btoa(JSON.stringify(unkeyed)) },
        });
      });
      const client = new X402Client(mockWallet);

      expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
      expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      const logs = client.getTransactionLog();
      expect(logs).toHaveLength(2);
      expect(logs[0].idempotencyKey).not.toBe(logs[1].idempotencyKey);
    } finally {
      if (originalCrypto) {
        Object.defineProperty(globalThis, 'crypto', originalCrypto);
      } else {
        delete (globalThis as { crypto?: unknown }).crypto;
      }
    }
  });

  it('logs the settled contract address even when the challenge names the asset by symbol', async () => {
    vi.spyOn(X402Client.prototype as any, 'executePayment').mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const bySymbol = paymentRequired();
      bySymbol.accepts[0].asset = 'USDC';
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(bySymbol)) },
      });
    });
    const client = new X402Client(mockWallet);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(client.getTransactionLog()[0].token.toLowerCase()).toBe(asset.toLowerCase());
  });

  it('surfaces a revert found by background reconfirmation to the next observer of that intent', async () => {
    const txA = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const txOther = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({ hash }: { hash: string }) => {
      if (hash !== txA) {
        return { status: 'success' };
      }
      const attempt = waitReceipt.mock.calls.filter((call) => call[0].hash === txA).length;
      if (attempt === 1) {
        throw new Error('RPC timeout');
      }
      if (attempt === 2) {
        return { status: 'reverted' };
      }
      return { status: 'success' };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockImplementation(async (...args: unknown[]) => {
        const selected = args[0] as { extra?: { nonce?: string } } | undefined;
        return { txHash: selected?.extra?.nonce === 'intent-a' ? txA : txOther };
      });
    mock402PerIntent();
    const client = new X402Client(wallet, { globalDailyLimit: 3000000n });

    // intent-a is broadcast but its receipt cannot be observed.
    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    // Unrelated activity reconfirms intent-a in the background and finds the revert.
    expect((await client.fetch(`${url}?n=intent-b`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => {
      expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    });
    expect(client.getDailySpendSummary().global).toBe(1_007_700n);

    // The next observation of intent-a fails closed instead of paying fresh.
    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(2);

    // Having observed the revert, the caller's own retry settles fresh.
    expect((await client.fetch(`${url}?n=intent-a`, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(client.getDailySpendSummary().global).toBe(2_015_400n);
  });

  it('backs off opportunistic reconfirmation while receipts keep failing', async () => {
    vi.useFakeTimers();
    const txA = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const txOther = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    let failuresForA = 0;
    const waitReceipt = vi.fn(async ({ hash }: { hash: string }) => {
      if (hash !== txA) {
        return { status: 'success' };
      }
      failuresForA += 1;
      if (failuresForA <= 4) {
        throw new Error('RPC timeout');
      }
      return { status: 'success' };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockImplementation(async (...args: unknown[]) => {
        const selected = args[0] as { extra?: { nonce?: string } } | undefined;
        return { txHash: selected?.extra?.nonce === 'intent-a' ? txA : txOther };
      });
    mock402PerIntent();
    const client = new X402Client(wallet);
    const attemptsForA = () => waitReceipt.mock.calls.filter((call) => call[0].hash === txA).length;

    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(attemptsForA()).toBe(1);

    // First unrelated payment reconfirms immediately; the next two are inside the backoff window.
    for (const n of ['b', 'c', 'd']) {
      expect((await client.fetch(`${url}?n=intent-${n}`, { method: 'POST' })).status).toBe(200);
    }
    expect(attemptsForA()).toBe(2);

    // After the backoff elapses, activity reconfirms again.
    vi.advanceTimersByTime(X402_RECONFIRM_BACKOFF_MS + 1);
    expect((await client.fetch(`${url}?n=intent-e`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(3);

    // The window doubles after each failure.
    vi.advanceTimersByTime(X402_RECONFIRM_BACKOFF_MS + 1);
    expect((await client.fetch(`${url}?n=intent-f`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(3);
    vi.advanceTimersByTime(X402_RECONFIRM_BACKOFF_MS + 1);
    expect((await client.fetch(`${url}?n=intent-g`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(4);
    expect(client.budgetTracker.getReservedSummary().global).toBe(1_007_700n);

    // A retry of the intent itself never waits for the backoff: it reconfirms
    // immediately, and replays the settled hash instead of paying again.
    expect((await client.fetch(`${url}?n=intent-a`, { method: 'POST' })).status).toBe(200);
    expect(attemptsForA()).toBe(5);
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(1);
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
  });

  it('retains a revert tombstone until the intent is observed, even past the replay window', async () => {
    vi.useFakeTimers();
    const txA = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const txOther = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const waitReceipt = vi.fn(async ({ hash }: { hash: string }) => {
      if (hash !== txA) {
        return { status: 'success' };
      }
      const attempt = waitReceipt.mock.calls.filter((call) => call[0].hash === txA).length;
      if (attempt === 1) {
        throw new Error('RPC timeout');
      }
      return { status: 'reverted' };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockImplementation(async (...args: unknown[]) => {
        const selected = args[0] as { extra?: { nonce?: string } } | undefined;
        return { txHash: selected?.extra?.nonce === 'intent-a' ? txA : txOther };
      });
    mock402PerIntent();
    const client = new X402Client(wallet);

    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect((await client.fetch(`${url}?n=intent-b`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => {
      expect(client.budgetTracker.getReservedSummary().global).toBe(0n);
    });

    // Well past the replay window, and with more unrelated activity in between,
    // the first observation of intent-a still fails closed.
    vi.advanceTimersByTime(X402_SETTLEMENT_RETRY_WINDOW_MS * 10);
    expect((await client.fetch(`${url}?n=intent-c`, { method: 'POST' })).status).toBe(200);
    await expect(client.fetch(`${url}?n=intent-a`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });

  it('does not write an optimistic log before a delayed revert is confirmed', async () => {
    const waitReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({ status: 'reverted' })
      .mockResolvedValue({ status: 'success' });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    vi.spyOn(X402Client.prototype as any, 'executePayment').mockResolvedValue({ txHash });
    const completions: Array<{ success: boolean; txHash: string; error?: string }> = [];
    mock402ThenPaid();
    const client = new X402Client(wallet, {
      onPaymentComplete: (log) => {
        completions.push({ success: log.success, txHash: log.txHash, error: log.error });
      },
    });

    await expect(client.fetch(url, { method: 'POST' })).rejects.toThrow('RPC timeout');
    expect(completions).toEqual([]);

    await expect(client.fetch(url, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect(client.getTransactionLog()).toEqual([]);
    expect(completions).toEqual([]);
    expect(client.getDailySpendSummary().global).toBe(0n);
  });

  it('refuses new explicit-intent transfers once the unconfirmed backlog reaches the ceiling', async () => {
    const waitReceipt = vi.fn(async () => {
      throw new Error('RPC down');
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402PerIntent();
    const client = new X402Client(wallet);

    for (let i = 0; i < X402_MAX_UNCONFIRMED_SETTLEMENTS; i++) {
      await expect(client.fetch(`${url}?n=intent-${i}`, { method: 'POST' })).rejects.toThrow('RPC down');
    }
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);

    // At the ceiling: no new broadcast, no new reservation, nothing evicted.
    await expect(client.fetch(`${url}?n=intent-overflow`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementBacklogError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);
    expect(client.budgetTracker.getReservedSummary().global)
      .toBe(BigInt(X402_MAX_UNCONFIRMED_SETTLEMENTS) * 1_007_700n);

    // A retry of an already-submitted intent is still reconfirmed, but no proof
    // can be emitted while the receipt endpoint remains unavailable.
    await expect(client.fetch(`${url}?n=intent-0`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementUnknownError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);
  });

  it('counts in-flight settlements against the unconfirmed backlog ceiling', async () => {
    const waitReceipt = vi.fn(() => new Promise<{ status: string }>(() => {}));
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    mock402PerIntent();
    const client = new X402Client(wallet);

    for (let i = 0; i < X402_MAX_UNCONFIRMED_SETTLEMENTS; i++) {
      void client.fetch(`${url}?n=intent-${i}`, { method: 'POST' });
    }
    await vi.waitFor(
      () => {
        expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);
      },
      { timeout: 10_000 },
    );

    await expect(
      client.fetch(`${url}?n=intent-overflow`, { method: 'POST' }),
    ).rejects.toBeInstanceOf(X402SettlementBacklogError);
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);

    // A retry of an already-submitted in-flight intent still shares the slot.
    void client.fetch(`${url}?n=intent-0`, { method: 'POST' });
    await Promise.resolve();
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);
  });

  it('keeps a confirmed settlement replayable for the challenge timeout when it exceeds the default window', async () => {
    vi.useFakeTimers();
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const longWindow = paymentRequired();
      longWindow.accepts[0].maxTimeoutSeconds = 300;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(longWindow)) },
      });
    });
    const client = new X402Client(mockWallet);

    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    vi.advanceTimersByTime(X402_SETTLEMENT_RETRY_WINDOW_MS + 60_000);
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(1);

    vi.advanceTimersByTime(300_000);
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('extends a cached settlement when the same intent is re-issued with a longer timeout', async () => {
    vi.useFakeTimers();
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockResolvedValue({ txHash });
    let timeoutSeconds = 30;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('X-PAYMENT')) {
        return new Response('paid', { status: 200 });
      }
      const challenge = paymentRequired();
      challenge.accepts[0].maxTimeoutSeconds = timeoutSeconds;
      return new Response(null, {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify(challenge)) },
      });
    });
    const client = new X402Client(mockWallet);

    // Settled under a 30s challenge (cached for the 120s default window).
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);

    // 60s later the server re-issues the same intent with a 300s window.
    vi.advanceTimersByTime(60_000);
    timeoutSeconds = 300;
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // 130s after the original settlement — past the default window, inside the
    // renewed one — the retry still replays instead of paying again.
    vi.advanceTimersByTime(70_000);
    expect((await client.fetch(url, { method: 'POST' })).status).toBe(200);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(client.getTransactionLog().filter((log) => log.replayed)).toHaveLength(2);
  });

  it('counts unobserved revert tombstones against the unconfirmed ceiling', async () => {
    const txOther = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const revertedHashes = new Set<string>();
    const waitReceipt = vi.fn(async ({ hash }: { hash: string }) => {
      if (hash === txOther) {
        return { status: 'success' };
      }
      const attempts = waitReceipt.mock.calls.filter((call) => call[0].hash === hash).length;
      if (attempts === 1) {
        throw new Error('RPC timeout');
      }
      revertedHashes.add(hash);
      return { status: 'reverted' };
    });
    const wallet = {
      publicClient: { waitForTransactionReceipt: waitReceipt },
    } as any;
    const executeSpy = vi.spyOn(X402Client.prototype as any, 'executePayment')
      .mockImplementation(async (...args: unknown[]) => {
        const selected = args[0] as { extra?: { nonce?: string } } | undefined;
        const nonce = String(selected?.extra?.nonce ?? '');
        return { txHash: nonce.startsWith('bad-') ? (`0x${nonce.slice(4).padStart(64, '0')}` as `0x${string}`) : txOther };
      });
    mock402PerIntent();
    const client = new X402Client(wallet);

    // Fill the ceiling with intents whose receipts first time out, then revert
    // in the background (never observed by their callers).
    for (let i = 0; i < X402_MAX_UNCONFIRMED_SETTLEMENTS; i++) {
      await expect(client.fetch(`${url}?n=bad-${i}`, { method: 'POST' })).rejects.toThrow('RPC timeout');
    }
    // At the ceiling (the last entry is still `unknown` until more activity
    // reconfirms it); this refused attempt is the activity that does so.
    await expect(client.fetch(`${url}?n=fresh`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementBacklogError,
    );
    await vi.waitFor(() => {
      expect(revertedHashes.size).toBe(X402_MAX_UNCONFIRMED_SETTLEMENTS);
    });
    expect(client.budgetTracker.getReservedSummary().global).toBe(0n);

    // Every one is now an unobserved tombstone: the ceiling still holds.
    await expect(client.fetch(`${url}?n=fresh`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementBacklogError,
    );
    expect(executeSpy).toHaveBeenCalledTimes(X402_MAX_UNCONFIRMED_SETTLEMENTS);

    // Observing one tombstone frees one slot.
    await expect(client.fetch(`${url}?n=bad-0`, { method: 'POST' })).rejects.toBeInstanceOf(
      X402SettlementRevertedError,
    );
    expect((await client.fetch(`${url}?n=fresh`, { method: 'POST' })).status).toBe(200);
  });

  it('exports the settlement error classes from both public barrels', async () => {
    const x402Barrel = await import('../index.js');
    const rootBarrel = await import('../../index.js');
    expect(x402Barrel.X402SettlementRevertedError).toBe(X402SettlementRevertedError);
    expect(x402Barrel.X402SettlementQueuedError).toBe(X402SettlementQueuedError);
    expect(x402Barrel.X402SettlementUnknownError).toBe(X402SettlementUnknownError);
    expect(x402Barrel.X402IntentTermsConflictError).toBe(X402IntentTermsConflictError);
    expect(x402Barrel.X402SettlementBacklogError).toBe(X402SettlementBacklogError);
    expect(rootBarrel.X402SettlementRevertedError).toBe(X402SettlementRevertedError);
    expect(rootBarrel.X402SettlementQueuedError).toBe(X402SettlementQueuedError);
    expect(rootBarrel.X402SettlementUnknownError).toBe(X402SettlementUnknownError);
    expect(rootBarrel.X402IntentTermsConflictError).toBe(X402IntentTermsConflictError);
    expect(rootBarrel.X402SettlementBacklogError).toBe(X402SettlementBacklogError);
  });
});
