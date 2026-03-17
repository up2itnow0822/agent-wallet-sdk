// [MAX-ADDED] Tests for x402 Client — protocol parsing and payment selection
import { describe, it, expect } from 'vitest';
import { X402Client } from '../client.js';
import { USDC_ADDRESSES } from '../types.js';
import type { X402PaymentRequired, X402PaymentRequirements } from '../types.js';

// Mock wallet (we test protocol logic, not on-chain execution)
const mockWallet = {} as any;

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

    it('returns null for unparseable 402', async () => {
      const client = new X402Client(mockWallet, { autoPay: false });
      const response = new Response('Payment Required', { status: 402 });
      const parsed = await client.parse402Response(response);
      expect(parsed).toBeNull();
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
