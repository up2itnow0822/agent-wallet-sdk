/**
 * cross-chain-identity.ts — Cross-Chain Agent Identity Resolution
 *
 * Demonstrates how agents on different chains can discover and verify
 * each other's identities using UAIDs (Universal Agent Identifiers).
 *
 * The UAID layer bridges ERC-8004 identities on EVM chains to agents
 * on Solana, Hedera, and off-chain frameworks via the HOL Registry.
 *
 * Prerequisites:
 *   - For resolution only: no API key needed
 *   - For registration: HOL API key (get one at https://hol.org)
 */
import {
  UAIDResolver,
  ERC8004Client,
  type UniversalAgentIdentity,
} from 'agentwallet-sdk';

async function main() {
  // ── 1. Resolve any agent by UAID (works across all chains) ─────────────

  const resolver = new UAIDResolver();

  // Resolve an ERC-8004 agent (EVM)
  const evmResult = await resolver.resolve(
    'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'
  );

  if (evmResult.resolved && evmResult.identity) {
    console.log('EVM Agent found:');
    console.log(`  Name: ${evmResult.identity.agentId}`);
    console.log(`  Payment: ${evmResult.identity.paymentAddress}`);
    console.log(`  Trust: ${evmResult.trustScore}/100`);
  }

  // Resolve a Hedera agent (non-EVM)
  const hederaResult = await resolver.resolve(
    'uaid:aid:hedera:0.0.5678;uid=agent-x;proto=openconvai'
  );

  if (hederaResult.resolved) {
    console.log('Hedera Agent found:', hederaResult.identity?.owner);
  }

  // ── 2. Convert ERC-8004 identity to universal format ───────────────────

  const erc8004 = new ERC8004Client({ chain: 'base' });
  const onChainIdentity = await erc8004.lookupAgentIdentity(42n);

  // Convert to universal format for cross-chain operations
  const universal: UniversalAgentIdentity = resolver.erc8004ToUniversal(
    onChainIdentity,
    'base'
  );

  console.log(`Universal ID: ${universal.uaid}`);
  console.log(`Protocol: ${universal.protocol}`);
  console.log(`Chain: ${universal.chain}`);

  // ── 3. Search for agents across all chains ─────────────────────────────

  const tradingAgents = await resolver.search('trading', {
    protocol: 'erc8004',
    minTrustScore: 50,
    limit: 10,
  });

  console.log(`Found ${tradingAgents.length} trading agents`);

  // ── 4. Verify an agent before transacting ──────────────────────────────

  const verification = await resolver.verify(
    'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'
  );

  if (verification.verified) {
    console.log(`Agent verified! Trust score: ${verification.trustScore}`);
    console.log(`Payment address: ${verification.identity?.paymentAddress}`);
    // Safe to proceed with x402 payment
  } else {
    console.log(`Agent not verified: ${verification.error}`);
  }

  // ── 5. Register your ERC-8004 agent for cross-chain discovery ──────────

  const registrationResolver = new UAIDResolver({
    apiKey: process.env.HOL_API_KEY, // Required for writes
  });

  const uaid = await registrationResolver.registerERC8004Agent({
    agentId: 42n,
    chain: 'base',
    name: 'My Trading Agent',
    description: 'Autonomous trading agent with x402 payment support',
    capabilities: ['trading', 'x402-payments', 'data-retrieval'],
  });

  console.log(`Registered! UAID: ${uaid}`);
  // Now agents on Solana, Hedera, etc. can find and verify this agent

  // ── 6. Parse UAID without network calls ────────────────────────────────

  const parsed = UAIDResolver.parseUAID(uaid);
  if (parsed) {
    console.log(`Protocol: ${parsed.protocol}`);
    console.log(`Agent ID: ${parsed.uid}`);
    console.log(`Identifier: ${parsed.aid}`);
  }
}

main().catch(console.error);
