import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_ACK, assertInstalledSpendPolicy, resolveExampleNetwork } from '../examples/_example-safety.js';

const EXAMPLES = join(__dirname, '..', 'examples');

describe('example safety (finding 20)', () => {
  it('defaults to Base Sepolia testnet USDC', () => {
    const net = resolveExampleNetwork({});
    expect(net.chainKey).toBe('base-sepolia');
    expect(net.live).toBe(false);
    expect(net.usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('refuses Base mainnet without the explicit live acknowledgement', () => {
    expect(() => resolveExampleNetwork({ AGENT_EXAMPLE_NETWORK: 'base' })).toThrow(/Refusing/);
    expect(() => resolveExampleNetwork({ AGENT_EXAMPLE_NETWORK: 'base', AGENT_EXAMPLE_LIVE_ACK: 'yes' })).toThrow(/Refusing/);
    expect(resolveExampleNetwork({ AGENT_EXAMPLE_NETWORK: 'base', AGENT_EXAMPLE_LIVE_ACK: LIVE_ACK }).live).toBe(true);
  });

  it('no example auto-runs main() on import', () => {
    for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(EXAMPLES, file), 'utf8');
      expect(src, file).not.toMatch(/^main\(\)/m);
    }
  });

  it('importing a funds example performs no signing or env reads', async () => {
    const before = { ...process.env };
    delete process.env.AGENT_PRIVATE_KEY;
    try {
      const mod = await import('../examples/micropayment-agent.js');
      expect(typeof mod.main).toBe('function');
      const trading = await import('../examples/trading-agent.js');
      expect(typeof trading.main).toBe('function');
      const x402 = await import('../examples/x402-payment.js');
      expect(typeof x402.main).toBe('function');
    } finally {
      process.env = before;
    }
  });

  it('refuses to spend unless the advertised policy is installed and no looser', async () => {
    const wallet = (perTx: bigint, period: bigint) => ({
      contract: { read: { spendPolicies: async () => [perTx, period, 86400n, 0n, 0n] } },
    }) as any;
    const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const limits = { perTx: 5n, perDay: 50n };
    await expect(assertInstalledSpendPolicy(wallet(0n, 0n), token, limits)).rejects.toThrow(/No on-chain/);
    await expect(assertInstalledSpendPolicy(wallet(10n, 50n), token, limits)).rejects.toThrow(/looser/);
    await expect(assertInstalledSpendPolicy(wallet(5n, 50n), token, limits)).resolves.toBeUndefined();
  });
});
