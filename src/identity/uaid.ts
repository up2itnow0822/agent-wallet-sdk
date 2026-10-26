/**
 * uaid.ts — Universal Agent Identifier (UAID) Resolution Layer
 *
 * Provides cross-chain agent identity resolution via the HOL Registry Broker.
 * UAIDs are chain-agnostic identifiers that bridge ERC-8004 tokens on EVM chains
 * to agents on Solana, Hedera, off-chain frameworks, and any other protocol.
 *
 * This module is an optional extension — agents that only operate on EVM chains
 * can continue using ERC8004Client directly.
 *
 * Registry: https://hol.org
 * SDK: @hol-org/rb-client (peer dependency — install only if needed)
 *
 * @module identity/uaid
 */

import { ERC8004Client, KNOWN_REGISTRY_ADDRESSES, type AgentIdentity, type AgentRegistrationFile, type SupportedChain } from './erc8004.js';
import { isAddress, type Address } from 'viem';
import { boundedFetch, parseBoundedJson, type BoundedResponse } from '../net/bounded-fetch.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported protocol types in the UAID ecosystem */
export type UAIDProtocol =
  | 'erc8004'
  | 'a2a'
  | 'openconvai'
  | 'virtuals'
  | 'x402'
  | 'hedera'
  | 'solana'
  | string;

/** A parsed UAID with its component parts */
export interface ParsedUAID {
  /** Raw UAID string */
  raw: string;
  /** Agent identifier portion */
  aid: string;
  /** Unique identifier portion */
  uid: string;
  /** Protocol used for resolution */
  protocol: UAIDProtocol;
  /** Native identifier on the protocol's own chain/system */
  nativeId?: string;
}

/** Result of resolving a UAID to a known identity */
export interface UAIDResolution {
  /** Whether resolution succeeded */
  resolved: boolean;
  /** The UAID that was resolved */
  uaid: string;
  /** Resolved agent identity (if ERC-8004 backed) */
  identity: UniversalAgentIdentity | null;
  /** Protocol the agent was resolved through */
  protocol: UAIDProtocol;
  /** Chain the identity lives on (if applicable) */
  chain?: string;
  /** Trust score reported by the broker (0-100). Unauthenticated broker data. */
  trustScore?: number;
  /**
   * The broker's own claim that it verified this agent. This is an
   * unauthenticated assertion from a network service — NOT proof of identity.
   * Use UAIDResolver.verify() for independent on-chain verification.
   */
  brokerAttested: boolean;
  /** @deprecated Same value as `brokerAttested` (broker claim, not verification). */
  registryVerified: boolean;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Universal agent identity — superset of ERC-8004 AgentIdentity that works
 * across chains. For EVM agents, this mirrors AgentIdentity. For non-EVM
 * agents, it provides equivalent fields using native identifiers.
 */
export interface UniversalAgentIdentity {
  /** Identifier — ERC-8004 tokenId for EVM, native ID for others */
  agentId: string;
  /** Owner — EVM address, Hedera account, Solana pubkey, etc. */
  owner: string;
  /** Agent URI / metadata endpoint */
  agentURI: string;
  /** Payment address (chain-native format) */
  paymentAddress: string;
  /** Registration metadata (if available) */
  registrationFile: AgentRegistrationFile | null;
  /** Source protocol */
  protocol: UAIDProtocol;
  /** Source chain */
  chain: string;
  /** UAID for cross-chain reference */
  uaid: string;
}

/** Configuration for the UAID resolver */
export interface UAIDResolverConfig {
  /** HOL Registry Broker API key (optional for read-only resolution) */
  apiKey?: string;
  /** Custom broker base URL (defaults to production) */
  brokerUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Cache resolved identities for this many ms (default: 300000 = 5 min) */
  cacheTtlMs?: number;
  /** Maximum cached resolutions (default: 1000, LRU-evicted). */
  cacheMaxEntries?: number;
  /** Maximum broker response size in bytes (default: 256 KiB). */
  maxResponseBytes?: number;
  /** RPC URLs used for independent ERC-8004 verification, per chain. */
  rpcUrls?: Partial<Record<SupportedChain, string>>;
  /** Additional trusted ERC-8004 identity registries per chain (besides KNOWN_REGISTRY_ADDRESSES). */
  trustedRegistries?: Partial<Record<SupportedChain, Address[]>>;
  /**
   * Override the on-chain lookup used by verify() (e.g. a custom client).
   * Must read owner and agent wallet at one block from the given registry.
   */
  onChainLookup?: (params: { chain: SupportedChain; registry: Address; agentId: bigint }) =>
    Promise<{ owner: Address; agentWallet: Address; blockNumber: bigint }>;
}

/** Result of UAIDResolver.verify(). */
export interface UAIDVerification {
  /** True only when the identity was independently verified on-chain. */
  verified: boolean;
  /** Identity built from verified on-chain values (owner, paymentAddress) when verified. */
  identity: UniversalAgentIdentity | null;
  /** Broker-reported trust score (unauthenticated). */
  trustScore: number;
  protocol: UAIDProtocol;
  /** The broker's own (unauthenticated) verification claim. */
  brokerAttested: boolean;
  /** Block at which the on-chain binding was read. */
  blockNumber?: bigint;
  error?: string;
}

/** Parameters for registering an ERC-8004 identity as a UAID */
export interface RegisterUAIDParams {
  /** ERC-8004 agent ID (tokenId) */
  agentId: bigint;
  /** Chain the identity is registered on */
  chain: SupportedChain;
  /** Registry contract address (uses known defaults if omitted) */
  registryAddress?: Address;
  /** Agent name for the registry */
  name: string;
  /** Agent description */
  description: string;
  /** Optional: additional capabilities to advertise */
  capabilities?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BROKER_URL = 'https://hol.org/registry/api/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_UAID_LENGTH = 512;
const MAX_FIELD_LENGTH = 2_048;
const MAX_SEARCH_RESULTS = 100;
const MAX_ERROR_TEXT = 256;

/** EVM chain IDs for UAID protocol mapping */
const EVM_CHAIN_IDS: Record<SupportedChain, number> = {
  'ethereum': 1,
  'base': 8453,
  'base-sepolia': 84532,
  'arbitrum': 42161,
  'arbitrum-sepolia': 421614,
  'polygon': 137,
};

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: UAIDResolution;
  expiresAt: number;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const CHAIN_BY_ID: Record<number, SupportedChain> = Object.fromEntries(
  Object.entries(EVM_CHAIN_IDS).map(([chain, id]) => [id, chain as SupportedChain]),
) as Record<number, SupportedChain>;

function str(value: unknown, field: string, max = MAX_FIELD_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`broker field ${field} must be a string`);
  if (value.length > max) throw new Error(`broker field ${field} is too long`);
  return value;
}

function idString(value: unknown, field: string): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return str(value, field, 128);
}

/** Canonical UAID: trimmed, bounded, parseable. Returns null otherwise. */
function canonicalUAID(uaid: unknown): string | null {
  if (typeof uaid !== 'string') return null;
  const trimmed = uaid.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_UAID_LENGTH) return null;
  return UAIDResolver.parseUAID(trimmed) ? trimmed : null;
}

/** Strictly validate one broker agent record against the UAID it must describe. */
function validateBrokerAgent(raw: unknown, expectedUaid: string): {
  identity: UniversalAgentIdentity; protocol: UAIDProtocol; chain?: string; trustScore?: number; brokerAttested: boolean;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('broker record is not an object');
  const d = raw as Record<string, unknown>;
  const parsed = UAIDResolver.parseUAID(expectedUaid);
  if (!parsed) throw new Error('requested UAID is malformed');

  const returnedUaid = str(d.uaid, 'uaid', MAX_UAID_LENGTH);
  if (returnedUaid !== undefined && returnedUaid !== expectedUaid) {
    throw new Error('broker returned a record for a different UAID');
  }
  const protocol = str(d.protocol, 'protocol', 64) ?? parsed.protocol;
  if (protocol !== parsed.protocol) throw new Error('broker protocol does not match the UAID');
  const agentId = idString(d.agentId ?? d.nativeId, 'agentId') ?? '';
  if (parsed.protocol === 'erc8004' && agentId !== '' && agentId !== parsed.uid) {
    throw new Error('broker agentId does not match the UAID uid');
  }
  const trustRaw = d.trustScore;
  let trustScore: number | undefined;
  if (trustRaw !== undefined && trustRaw !== null) {
    if (typeof trustRaw !== 'number' || !Number.isFinite(trustRaw) || trustRaw < 0 || trustRaw > 100) {
      throw new Error('broker trustScore must be a number in [0, 100]');
    }
    trustScore = trustRaw;
  }
  if (d.verified !== undefined && typeof d.verified !== 'boolean') throw new Error('broker verified must be boolean');
  const registrationFile = d.registrationFile;
  if (registrationFile !== undefined && registrationFile !== null && (typeof registrationFile !== 'object' || Array.isArray(registrationFile))) {
    throw new Error('broker registrationFile must be an object');
  }
  const chain = str(d.chain, 'chain', 128);
  return {
    identity: {
      agentId: agentId || parsed.uid,
      owner: str(d.owner ?? d.controller, 'owner', 128) ?? '',
      agentURI: str(d.agentURI ?? d.metadataUri, 'agentURI') ?? '',
      paymentAddress: str(d.paymentAddress ?? d.agentWallet, 'paymentAddress', 128) ?? '',
      registrationFile: (registrationFile ?? null) as AgentRegistrationFile | null,
      protocol,
      chain: chain ?? '',
      uaid: expectedUaid,
    },
    protocol,
    chain,
    trustScore,
    brokerAttested: d.verified === true,
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class UAIDResolver {
  private readonly brokerUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly maxResponseBytes: number;
  private readonly config: UAIDResolverConfig;
  /** Insertion-ordered Map used as an LRU: oldest entries are evicted first. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: UAIDResolverConfig = {}) {
    this.brokerUrl = (config.brokerUrl ?? DEFAULT_BROKER_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheMaxEntries = Math.max(0, Math.floor(config.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES));
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.config = { ...config };
  }

  /** Current number of cached resolutions (bounded by cacheMaxEntries). */
  get cacheSize(): number {
    return this.cache.size;
  }

  private cacheGet(key: string): UAIDResolution | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined; // expired entries are removed, not kept
    this.cache.set(key, entry); // refresh LRU position
    return entry.result;
  }

  private cacheSet(key: string, result: UAIDResolution): void {
    if (this.cacheMaxEntries === 0 || this.cacheTtlMs <= 0) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
    this.cache.delete(key);
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { result, expiresAt: now + this.cacheTtlMs });
  }

  // ── Core resolution ──────────────────────────────────────────────────────

  /**
   * Resolve a UAID to an agent identity.
   *
   * Works across chains — the resolver contacts the HOL Registry Broker to
   * find the agent's identity regardless of whether it lives on EVM, Hedera,
   * Solana, or off-chain.
   *
   * @param uaid - Universal Agent Identifier string
   * @returns Resolution result with identity details
   *
   * @example
   * ```ts
   * const resolver = new UAIDResolver();
   * const result = await resolver.resolve('uaid:aid:0x8004...;uid=42;proto=erc8004');
   * if (result.resolved) {
   *   console.log(result.identity?.paymentAddress);
   * }
   * ```
   */
  async resolve(uaid: string): Promise<UAIDResolution> {
    const key = canonicalUAID(uaid);
    if (!key) {
      return {
        resolved: false, uaid: String(uaid).slice(0, MAX_UAID_LENGTH), identity: null, protocol: 'unknown',
        brokerAttested: false, registryVerified: false, error: 'Malformed or oversized UAID',
      };
    }
    const cached = this.cacheGet(key);
    if (cached) return cached;

    try {
      const response = await this.brokerRequest('GET', `/agents/resolve?uaid=${encodeURIComponent(key)}`);

      if (!response.ok) {
        return {
          resolved: false, uaid: key, identity: null, protocol: 'unknown',
          brokerAttested: false, registryVerified: false, error: `Registry returned ${response.status}`,
        };
      }

      const record = validateBrokerAgent(parseBoundedJson(response.text, 'broker response'), key);
      const result: UAIDResolution = Object.freeze({
        resolved: true, uaid: key, identity: Object.freeze(record.identity),
        protocol: record.protocol,
        chain: record.chain,
        trustScore: record.trustScore,
        brokerAttested: record.brokerAttested,
        registryVerified: record.brokerAttested,
      });
      this.cacheSet(key, result);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        resolved: false, uaid: key, identity: null, protocol: 'unknown',
        brokerAttested: false, registryVerified: false, error: `Resolution failed: ${message.slice(0, MAX_ERROR_TEXT)}`,
      };
    }
  }

  /**
   * Search the HOL registry for agents matching criteria.
   *
   * @param query - Search terms (name, capability, protocol)
   * @param options - Optional filters
   * @returns Array of matching UAIDResolution results
   */
  async search(
    query: string,
    options?: { protocol?: UAIDProtocol; limit?: number; minTrustScore?: number }
  ): Promise<UAIDResolution[]> {
    try {
      const params = new URLSearchParams({ q: query });
      if (options?.protocol) params.set('protocol', options.protocol);
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.minTrustScore) params.set('minTrust', String(options.minTrustScore));

      const response = await this.brokerRequest('GET', `/agents/search?${params}`);
      if (!response.ok) return [];

      const data = parseBoundedJson(response.text, 'broker search response') as { agents?: unknown };
      if (!data || typeof data !== 'object' || !Array.isArray(data.agents)) return [];
      const limit = Math.min(options?.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const results: UAIDResolution[] = [];
      for (const agent of data.agents.slice(0, limit)) {
        const key = canonicalUAID((agent as { uaid?: unknown } | null)?.uaid);
        if (!key) continue;
        try {
          const record = validateBrokerAgent(agent, key);
          results.push({
            resolved: true, uaid: key, identity: record.identity,
            protocol: record.protocol, chain: record.chain, trustScore: record.trustScore,
            brokerAttested: record.brokerAttested, registryVerified: record.brokerAttested,
          });
        } catch { /* skip malformed broker entries */ }
      }
      return results;
    } catch {
      return [];
    }
  }

  // ── ERC-8004 ↔ UAID bridge ────────────────────────────────────────────────

  /**
   * Convert an ERC-8004 AgentIdentity to a UniversalAgentIdentity.
   *
   * Useful when you already have an on-chain identity and want to work
   * with the universal format (e.g., for cross-chain discovery).
   */
  erc8004ToUniversal(identity: AgentIdentity, chain: SupportedChain): UniversalAgentIdentity {
    const chainId = EVM_CHAIN_IDS[chain];
    return {
      agentId: identity.agentId.toString(),
      owner: identity.owner,
      agentURI: identity.agentURI,
      paymentAddress: identity.agentWallet,
      registrationFile: identity.registrationFile,
      protocol: 'erc8004',
      chain: `eip155:${chainId}`,
      uaid: `uaid:aid:eip155:${chainId}:${identity.owner};uid=${identity.agentId};proto=erc8004`,
    };
  }

  /**
   * Build a UAID string for an ERC-8004 agent.
   *
   * This creates the identifier — it does NOT register with the HOL registry.
   * Use registerERC8004Agent() to make the agent discoverable cross-chain.
   */
  buildERC8004UAID(agentId: bigint, chain: SupportedChain, ownerAddress: Address): string {
    const chainId = EVM_CHAIN_IDS[chain];
    return `uaid:aid:eip155:${chainId}:${ownerAddress};uid=${agentId};proto=erc8004`;
  }

  /**
   * Register an ERC-8004 agent in the HOL registry for cross-chain discovery.
   *
   * After registration, agents on Solana, Hedera, or any protocol can
   * discover and verify this agent's identity via its UAID.
   *
   * Requires an API key with write permissions.
   *
   * @param params - Registration parameters
   * @returns The assigned UAID
   */
  async registerERC8004Agent(params: RegisterUAIDParams): Promise<string> {
    if (!this.apiKey) {
      throw new Error('UAIDResolver: API key required for registration. Get one at https://hol.org');
    }

    const chainId = EVM_CHAIN_IDS[params.chain];
    const uaid = `uaid:aid:eip155:${chainId}:${params.registryAddress ?? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'};uid=${params.agentId};proto=erc8004`;

    const response = await this.brokerRequest('POST', '/agents/register', {
      uaid,
      protocol: 'erc8004',
      chain: `eip155:${chainId}`,
      agentId: params.agentId.toString(),
      name: params.name,
      description: params.description,
      capabilities: params.capabilities ?? [],
      registryAddress: params.registryAddress ?? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    });

    if (!response.ok) {
      throw new Error(`UAIDResolver: Registration failed (${response.status}): ${response.text.slice(0, MAX_ERROR_TEXT)}`);
    }

    const data = parseBoundedJson(response.text, 'broker registration response') as { uaid?: unknown } | null;
    const returned = data && typeof data === 'object' ? canonicalUAID(data.uaid) : null;
    if (!returned) return uaid;
    const want = UAIDResolver.parseUAID(uaid)!;
    const got = UAIDResolver.parseUAID(returned)!;
    if (got.aid !== want.aid || got.uid !== want.uid || got.protocol !== want.protocol) {
      throw new Error('UAIDResolver: broker returned a UAID for a different agent');
    }
    return returned;
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verify an agent's identity via UAID — works across any chain.
   *
   * This is the cross-chain equivalent of ERC8004Client.lookupAgentIdentity().
   * For EVM agents, it verifies the UAID maps to a valid on-chain ERC-8004 token.
   * For non-EVM agents, it verifies through the registry's native trust mechanism.
   *
   * @param uaid - Universal Agent Identifier to verify
   * @returns Verification result
   */
  async verify(uaid: string): Promise<UAIDVerification> {
    const resolution = await this.resolve(uaid);

    if (!resolution.resolved || !resolution.identity) {
      return {
        verified: false, identity: null, trustScore: 0, protocol: resolution.protocol,
        brokerAttested: false, error: resolution.error ?? 'Agent not found in registry',
      };
    }
    const base = {
      trustScore: resolution.trustScore ?? 0,
      protocol: resolution.protocol,
      brokerAttested: resolution.brokerAttested,
    };
    const unverified = (error: string): UAIDVerification => ({ verified: false, identity: null, ...base, error });

    const parsed = UAIDResolver.parseUAID(resolution.uaid);
    if (!parsed || parsed.protocol !== 'erc8004') {
      return unverified(`No independent verification is available for protocol "${parsed?.protocol ?? 'unknown'}"; broker claims are not proof of identity.`);
    }
    // ERC-8004 UAID aid: eip155:<chainId>:<identity registry>
    const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(parsed.aid);
    if (!m) return unverified('ERC-8004 UAID must be eip155:<chainId>:<registry address>');
    const chain = CHAIN_BY_ID[Number(m[1])];
    if (!chain) return unverified(`Unsupported ERC-8004 chain id ${m[1]}`);
    const registry = m[2] as Address;
    const trusted = [KNOWN_REGISTRY_ADDRESSES[chain]?.identity, ...(this.config.trustedRegistries?.[chain] ?? [])]
      .filter((a): a is Address => typeof a === 'string')
      .map((a) => a.toLowerCase());
    if (!trusted.includes(registry.toLowerCase())) return unverified(`Registry ${registry} is not a trusted ERC-8004 identity registry on ${chain}`);
    if (!/^\d{1,78}$/.test(parsed.uid)) return unverified('ERC-8004 uid must be a decimal token id');
    const agentId = BigInt(parsed.uid);

    let binding: { owner: Address; agentWallet: Address; blockNumber: bigint };
    try {
      binding = this.config.onChainLookup
        ? await this.config.onChainLookup({ chain, registry, agentId })
        : await new ERC8004Client({ chain, registryAddress: registry, rpcUrl: this.config.rpcUrls?.[chain] }).readAgentBinding(agentId);
    } catch (err) {
      return unverified(`On-chain verification failed: ${(err as Error).message.slice(0, MAX_ERROR_TEXT)}`);
    }
    if (!isAddress(binding.owner, { strict: false }) || !isAddress(binding.agentWallet, { strict: false })) {
      return unverified('On-chain lookup returned invalid addresses');
    }
    const brokerOwner = resolution.identity.owner;
    const brokerWallet = resolution.identity.paymentAddress;
    if (brokerOwner && brokerOwner.toLowerCase() !== binding.owner.toLowerCase()) {
      return unverified('Broker owner does not match the on-chain owner');
    }
    if (brokerWallet && brokerWallet.toLowerCase() !== binding.agentWallet.toLowerCase()) {
      return unverified('Broker payment address does not match the on-chain agent wallet');
    }
    return {
      verified: true,
      identity: Object.freeze({
        ...resolution.identity,
        owner: binding.owner,
        paymentAddress: binding.agentWallet,
        chain: `eip155:${m[1]}`,
      }),
      blockNumber: binding.blockNumber,
      ...base,
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Parse a UAID string into its components.
   *
   * Format: `uaid:aid:<identifier>;uid=<unique-id>;proto=<protocol>[;nativeId=<id>]`
   */
  static parseUAID(uaid: string): ParsedUAID | null {
    if (typeof uaid !== 'string' || uaid.length > MAX_UAID_LENGTH || !uaid.startsWith('uaid:')) return null;

    const parts = uaid.split(';');
    const aidPart = parts.find(p => p.startsWith('uaid:aid:'));
    const uidPart = parts.find(p => p.startsWith('uid='));
    const protoPart = parts.find(p => p.startsWith('proto='));
    const nativeIdPart = parts.find(p => p.startsWith('nativeId='));

    if (!aidPart || !uidPart || !protoPart) return null;

    return {
      raw: uaid,
      aid: aidPart.replace('uaid:aid:', ''),
      uid: uidPart.replace('uid=', ''),
      protocol: protoPart.replace('proto=', '') as UAIDProtocol,
      nativeId: nativeIdPart?.replace('nativeId=', ''),
    };
  }

  /** Clear the resolution cache */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async brokerRequest(method: string, path: string, body?: unknown): Promise<BoundedResponse> {
    const url = `${this.brokerUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'agentwallet-sdk/uaid-resolver',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    // One deadline covers the request AND the body; the body is size-capped.
    return boundedFetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }, { timeoutMs: this.timeoutMs, maxBytes: this.maxResponseBytes });
  }
}
