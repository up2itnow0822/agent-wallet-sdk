// [MAX-ADDED] Tests for x402 Client — protocol parsing and payment selection
import { describe, it, expect, vi, afterEach } from 'vitest';
import { X402Client, X402PaymentError } from '../client.js';
import { USDC_ADDRESSES } from '../types.js';
import type { X402PaymentRequired, X402PaymentRequirements } from '../types.js';

const mockCheckBudget = vi.fn();
const mockAgentTransferToken = vi.fn();

vi.mock('../../index.js', () => ({
  checkBudget: (...args: unknown[]) => mockCheckBudget(...args),
  agentTransferToken: (...args: unknown[]) => mockAgentTransferToken(...args),
}));

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TRANSACTION_QUEUED_TOPIC =
  '0x338e4b9b04df0b67a953d7ea6a7037128b8c6948e3d8c09a9d51a5f5be6c2284';
const TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FEE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function makeWallet(waitForTransactionReceipt: ReturnType<typeof vi.fn>) {
  return {
    address: WALLET_ADDRESS,
    publicClient: { waitForTransactionReceipt },
  } as any;
}

function exactPaymentRequired(url = 'https://api.example.com/premium/data'): X402PaymentRequired {
  return {
    x402Version: 1,
    resource: { url, description: 'Data API', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'base:8453',
        asset: BASE_USDC,
        amount: '1000000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 30,
        extra: {},
      },
    ],
  };
}

function paymentRequiredResponse(paymentRequired: X402PaymentRequired): Response {
  return new Response(null, {
    status: 402,
    headers: { 'payment-required': btoa(JSON.stringify(paymentRequired)) },
  });
}

// Mock wallet (we test protocol logic, not on-chain execution)
const mockWallet = {} as any;

afterEach(() => {
  vi.restoreAllMocks();
  mockCheckBudget.mockReset();
  mockAgentTransferToken.mockReset();
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

  describe('payment settlement', () => {
    it('retries with X-PAYMENT only after the transfer receipt confirms', async () => {
      const waitForReceipt = vi.fn()
        .mockResolvedValueOnce({ status: 'success', logs: [] })
        .mockResolvedValueOnce({ status: 'success', logs: [] });
      const client = new X402Client(makeWallet(waitForReceipt));
      mockCheckBudget.mockResolvedValue({
        token: BASE_USDC,
        perTxLimit: 10_000_000n,
        remainingInPeriod: 10_000_000n,
      });
      mockAgentTransferToken
        .mockResolvedValueOnce(FEE_HASH)
        .mockResolvedValueOnce(TX_HASH);

      const paid = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(paymentRequiredResponse(exactPaymentRequired()))
        .mockResolvedValueOnce(paid);

      const result = await client.fetch('https://api.example.com/premium/data');

      expect(result).toBe(paid);
      expect(waitForReceipt).toHaveBeenNthCalledWith(1, { hash: FEE_HASH });
      expect(waitForReceipt).toHaveBeenNthCalledWith(2, { hash: TX_HASH });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(client.getTransactionLog()).toHaveLength(1);
      expect(client.getTransactionLog()[0].success).toBe(true);
    });

    it('does not retry or record spend when the transfer is queued', async () => {
      const waitForReceipt = vi.fn()
        .mockResolvedValueOnce({ status: 'success', logs: [] })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [{ address: WALLET_ADDRESS, topics: [TRANSACTION_QUEUED_TOPIC] }],
        });
      const client = new X402Client(makeWallet(waitForReceipt));
      mockCheckBudget.mockResolvedValue({
        token: BASE_USDC,
        perTxLimit: 10_000_000n,
        remainingInPeriod: 10_000_000n,
      });
      mockAgentTransferToken
        .mockResolvedValueOnce(FEE_HASH)
        .mockResolvedValueOnce(TX_HASH);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(paymentRequiredResponse(exactPaymentRequired()));

      await expect(client.fetch('https://api.example.com/premium/data'))
        .rejects.toBeInstanceOf(X402PaymentError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(client.getTransactionLog()).toHaveLength(0);
    });

    it('does not retry or record spend when the transfer reverts', async () => {
      const waitForReceipt = vi.fn()
        .mockResolvedValueOnce({ status: 'success', logs: [] })
        .mockResolvedValueOnce({ status: 'reverted', logs: [] });
      const client = new X402Client(makeWallet(waitForReceipt));
      mockCheckBudget.mockResolvedValue({
        token: BASE_USDC,
        perTxLimit: 10_000_000n,
        remainingInPeriod: 10_000_000n,
      });
      mockAgentTransferToken
        .mockResolvedValueOnce(FEE_HASH)
        .mockResolvedValueOnce(TX_HASH);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(paymentRequiredResponse(exactPaymentRequired()));

      await expect(client.fetch('https://api.example.com/premium/data'))
        .rejects.toBeInstanceOf(X402PaymentError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(client.getTransactionLog()).toHaveLength(0);
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

