/**
 * ERC-8004: Trustless Agents — Identity Registry Integration
 *
 * Implements the Identity Registry component of ERC-8004, which provides every
 * AI agent with a portable, censorship-resistant on-chain identifier using ERC-721
 * with URIStorage extension.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 * Status: DRAFT (August 2025). No official mainnet singleton deployed yet.
 * Key Principle: Non-custodial. All signing happens locally via WalletClient.
 */
import {
  createPublicClient,
  getContract,
  http,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { base, baseSepolia, mainnet, arbitrum, arbitrumSepolia, polygon } from 'viem/chains';

// ─── ABI ─────────────────────────────────────────────────────────────────────

export const ERC8004IdentityRegistryAbi = [
  // register() — no args
  {
    name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  // register(string) — URI only
  {
    name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  // register(string,tuple[]) — URI + metadata
  {
    name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      { name: 'metadata', type: 'tuple[]', components: [
        { name: 'metadataKey', type: 'string' },
        { name: 'metadataValue', type: 'bytes' },
      ]},
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'setAgentURI', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'newURI', type: 'string' }],
    outputs: [],
  },
  {
    name: 'tokenURI', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'getMetadata', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'metadataKey', type: 'string' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'setMetadata', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'getAgentWallet', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'setAgentWallet', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' }, { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'unsetAgentWallet', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [],
  },
  {
    name: 'ownerOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'Registered', type: 'event', inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    name: 'Transfer', type: 'event', inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    name: 'URIUpdated', type: 'event', inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'newURI', type: 'string', indexed: false },
      { name: 'updatedBy', type: 'address', indexed: true },
    ],
  },
  {
    name: 'MetadataSet', type: 'event', inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentServiceEndpoint {
  name: string;
  endpoint: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

export type SupportedTrustMechanism = 'reputation' | 'crypto-economic' | 'tee-attestation' | 'zkml' | string;

export interface AgentRegistrationRef {
  agentId: number;
  agentRegistry: string;
}

export interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  services?: AgentServiceEndpoint[];
  x402Support?: boolean;
  active?: boolean;
  registrations?: AgentRegistrationRef[];
  supportedTrust?: SupportedTrustMechanism[];
  [key: string]: unknown;
}

export interface AgentModelMetadata {
  model?: string;
  provider?: string;
  version?: string;
  capabilities?: string[];
  framework?: string;
}

export interface AgentIdentity {
  agentId: bigint;
  owner: Address;
  agentURI: string;
  agentWallet: Address;
  registrationFile: AgentRegistrationFile | null;
  modelMetadata: AgentModelMetadata | null;
}

export interface MetadataEntry {
  metadataKey: string;
  metadataValue: Hex;
}

export type SupportedChain = 'base' | 'base-sepolia' | 'ethereum' | 'arbitrum' | 'polygon' | 'arbitrum-sepolia';

export interface AgentURIResolverContext {
  /** Best-effort cancellation. The resolver must stop its own network work on abort. */
  signal: AbortSignal;
  /** Maximum UTF-8 JSON bytes; enforce this while reading, before buffering the body. */
  maxBytes: number;
}

/**
 * Explicitly trusted external metadata resolver. The SDK does not perform HTTP
 * requests or enforce destination safety for this callback. Server resolvers must
 * enforce an exact HTTPS destination allowlist, reject private/local/reserved IPv4
 * and IPv6 DNS results, and bind connections to validated addresses to prevent DNS
 * rebinding. Disable redirects or apply the same policy to every redirect. Bound
 * network time/body consumption and honor the signal; the SDK only bounds its own
 * wait and the JSON text it accepts. Do not pass an unrestricted fetch wrapper.
 */
export type AgentURIResolver = (uri: string, context: AgentURIResolverContext) => Promise<string>;

export interface AgentURIResolutionOptions {
  /** Opt in to external HTTPS metadata with a resolver whose network policy you control. */
  resolver?: AgentURIResolver;
  /** Maximum accepted UTF-8 JSON bytes, including inline data. Default: 256 KiB. */
  maxBytes?: number;
  /** Maximum wait for the external resolver in milliseconds. Default: 5,000. */
  timeoutMs?: number;
}

export interface ERC8004ClientConfig {
  registryAddress?: Address;
  chain: SupportedChain;
  rpcUrl?: string;
  /** Inline metadata only by default. External metadata requires a trusted resolver. */
  uriResolution?: AgentURIResolutionOptions;
}

export interface RegistrationResult {
  txHash: Hash;
  agentId: bigint | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const METADATA_KEYS = {
  AGENT_WALLET: 'agentWallet',
  MODEL: 'agentModel',
  MODEL_PROVIDER: 'agentModelProvider',
  VERSION: 'agentVersion',
  CAPABILITIES: 'agentCapabilities',
  FRAMEWORK: 'agentFramework',
} as const;

export const REGISTRATION_FILE_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export const KNOWN_REGISTRY_ADDRESSES: Record<string, { identity: Address; reputation: Address; validation?: Address }> = {
  'ethereum': {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'base': {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'arbitrum': {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'polygon': {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'base-sepolia': {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
  'arbitrum-sepolia': {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
};

const CHAINS: Record<string, Chain> = {
  base, 'base-sepolia': baseSepolia, ethereum: mainnet, arbitrum, polygon,
  'arbitrum-sepolia': arbitrumSepolia,
};

const REGISTERED_TOPIC = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a';
const DEFAULT_METADATA_MAX_BYTES = 256 * 1024;
const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
const DATA_URI_PREFIX = 'data:application/json;base64,';

// ─── Client ──────────────────────────────────────────────────────────────────

export class ERC8004Client {
  private readonly publicClient: PublicClient;
  private readonly config: ERC8004ClientConfig & { registryAddress: Address };
  private readonly chain: Chain;

  constructor(config: ERC8004ClientConfig) {
    // Auto-resolve registry address from KNOWN_REGISTRY_ADDRESSES if not explicitly provided
    const resolvedAddress = config.registryAddress ?? KNOWN_REGISTRY_ADDRESSES[config.chain]?.identity;
    if (!resolvedAddress) {
      throw new Error(`ERC8004Client: No registry address provided and no known address for chain "${config.chain}"`);
    }
    this.config = {
      ...config, registryAddress: resolvedAddress,
      uriResolution: config.uriResolution ? { ...config.uriResolution } : undefined,
    };
    const chain = CHAINS[config.chain];
    if (!chain) throw new Error(`ERC8004Client: Unsupported chain "${config.chain}"`);
    this.chain = chain;
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  }

  private getReadContract() {
    return getContract({
      address: this.config.registryAddress,
      abi: ERC8004IdentityRegistryAbi,
      client: this.publicClient,
    });
  }

  private getWriteContract(walletClient: WalletClient) {
    return getContract({
      address: this.config.registryAddress,
      abi: ERC8004IdentityRegistryAbi,
      client: { public: this.publicClient, wallet: walletClient },
    });
  }

  async registerAgent(
    walletClient: WalletClient,
    metadata: Omit<AgentRegistrationFile, 'type'>,
    agentURI?: string,
    onChainMetadata?: Record<string, string>,
  ): Promise<RegistrationResult> {
    if (!walletClient.account) throw new Error('ERC8004Client: WalletClient has no account');

    const registrationFile = { type: REGISTRATION_FILE_TYPE, ...metadata } as AgentRegistrationFile;
    const resolvedURI = agentURI ?? buildDataURI(registrationFile);
    const contract = this.getWriteContract(walletClient);

    let txHash: Hash;
    if (onChainMetadata && Object.keys(onChainMetadata).length > 0) {
      const entries = encodeMetadataEntries(onChainMetadata);
      txHash = await contract.write.register([resolvedURI, entries], {
        account: walletClient.account, chain: this.chain,
      });
    } else {
      txHash = await contract.write.register([resolvedURI], {
        account: walletClient.account, chain: this.chain,
      });
    }

    let agentId: bigint | null = null;
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      const registeredEvent = receipt.logs.find(
        (log) =>
          log.address.toLowerCase() === this.config.registryAddress.toLowerCase() &&
          log.topics[0] === REGISTERED_TOPIC,
      );
      if (registeredEvent?.topics[1]) {
        agentId = BigInt(registeredEvent.topics[1]);
      }
    } catch {
      // agentId remains null
    }

    return { txHash, agentId };
  }

  async lookupAgentIdentity(agentId: bigint): Promise<AgentIdentity> {
    return this.lookupAgentIdentityAtBlock(agentId);
  }

  /** Registry address this client reads. */
  get registryAddress(): Address {
    return this.config.registryAddress;
  }

  /**
   * Read owner and agent wallet for `agentId` at ONE block snapshot (no
   * metadata fetch). Used to independently verify broker-supplied identity.
   */
  async readAgentBinding(agentId: bigint): Promise<{ owner: Address; agentWallet: Address; agentURI: string; blockNumber: bigint }> {
    // The identity registry address is shared across chains: prove the RPC
    // endpoint (not just the client config) serves this client's chain.
    // The check brackets the reads: a load balancer that switches networks
    // mid-read invalidates the snapshot instead of verifying another chain.
    const assertChain = async (when: string) => {
      const rpcChainId = await this.publicClient.getChainId();
      if (rpcChainId !== this.chain.id) {
        throw new Error(`ERC8004Client: RPC serves chain ${rpcChainId}, not ${this.config.chain} (${this.chain.id}) ${when}`);
      }
    };
    await assertChain('before the binding read');
    const blockNumber = await this.publicClient.getBlockNumber();
    const contract = this.getReadContract();
    const [owner, agentWallet, agentURI] = await Promise.all([
      contract.read.ownerOf([agentId], { blockNumber }),
      contract.read.getAgentWallet([agentId], { blockNumber }),
      contract.read.tokenURI([agentId], { blockNumber }),
    ]);
    await assertChain('after the binding read');
    return { owner: owner as Address, agentWallet: agentWallet as Address, agentURI: agentURI as string, blockNumber };
  }

  private async lookupAgentIdentityAtBlock(agentId: bigint, blockNumber?: bigint): Promise<AgentIdentity> {
    const contract = this.getReadContract();
    const readOptions = blockNumber === undefined ? undefined : { blockNumber };
    const [owner, agentURI, agentWallet] = await Promise.all([
      contract.read.ownerOf([agentId], readOptions),
      contract.read.tokenURI([agentId], readOptions),
      contract.read.getAgentWallet([agentId], readOptions),
    ]);

    let registrationFile: AgentRegistrationFile | null = null;
    try {
      registrationFile = await resolveAgentURI(agentURI as string, this.config.uriResolution);
    } catch { /* disabled, rejected, or unavailable */ }

    const modelMetadata = await this.readModelMetadata(agentId, blockNumber);

    return {
      agentId, owner: owner as Address, agentURI: agentURI as string,
      agentWallet: agentWallet as Address, registrationFile, modelMetadata,
    };
  }

  /**
   * Finds the newest discovered token currently owned at one block snapshot.
   * fromBlock limits discovery; earlier registrations/transfers may be missed.
   * Ownership can change after the snapshot, so this is not payment authorization.
   */
  async lookupAgentByOwner(ownerAddress: Address, fromBlock: bigint = 0n): Promise<AgentIdentity | null> {
    const blockNumber = await this.publicClient.getBlockNumber();
    const [registrations, transfers] = await Promise.all([this.publicClient.getLogs({
      address: this.config.registryAddress,
      event: {
        type: 'event', name: 'Registered',
        inputs: [
          { name: 'agentId', type: 'uint256', indexed: true },
          { name: 'agentURI', type: 'string', indexed: false },
          { name: 'owner', type: 'address', indexed: true },
        ],
      },
      args: { owner: ownerAddress },
      fromBlock, toBlock: blockNumber,
    }), this.publicClient.getLogs({
      address: this.config.registryAddress,
      event: {
        type: 'event', name: 'Transfer',
        inputs: [
          { name: 'from', type: 'address', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'tokenId', type: 'uint256', indexed: true },
        ],
      },
      args: { to: ownerAddress },
      fromBlock, toBlock: blockNumber,
    })]);

    const candidates = [
      ...registrations.map((log) => ({ agentId: log.args.agentId, blockNumber: log.blockNumber, logIndex: log.logIndex })),
      ...transfers.map((log) => ({ agentId: log.args.tokenId, blockNumber: log.blockNumber, logIndex: log.logIndex })),
    ].sort((a, b) => {
      const aBlock = a.blockNumber ?? 0n;
      const bBlock = b.blockNumber ?? 0n;
      return aBlock === bBlock ? (b.logIndex ?? 0) - (a.logIndex ?? 0) : aBlock > bBlock ? -1 : 1;
    });
    const seen = new Set<bigint>();
    const expectedOwner = ownerAddress.toLowerCase();
    const contract = this.getReadContract();
    for (const { agentId } of candidates) {
      if (agentId === undefined || seen.has(agentId)) continue;
      seen.add(agentId);
      const owner = await contract.read.ownerOf([agentId], { blockNumber });
      if (owner.toLowerCase() !== expectedOwner) continue;
      const identity = await this.lookupAgentIdentityAtBlock(agentId, blockNumber);
      if (identity.owner.toLowerCase() === expectedOwner) return identity;
    }
    return null;
  }

  async updateAgentURI(walletClient: WalletClient, agentId: bigint, newURI: string): Promise<Hash> {
    if (!walletClient.account) throw new Error('ERC8004Client: WalletClient has no account');
    const contract = this.getWriteContract(walletClient);
    return contract.write.setAgentURI([agentId, newURI], {
      account: walletClient.account, chain: this.chain,
    });
  }

  async getOnChainMetadata(agentId: bigint, key: string, blockNumber?: bigint): Promise<Hex | null> {
    const contract = this.getReadContract();
    const value = await contract.read.getMetadata([agentId, key], blockNumber === undefined ? undefined : { blockNumber });
    return value === '0x' || value === null ? null : value as Hex;
  }

  async setOnChainMetadata(walletClient: WalletClient, agentId: bigint, key: string, value: string): Promise<Hash> {
    if (!walletClient.account) throw new Error('ERC8004Client: WalletClient has no account');
    if (key === METADATA_KEYS.AGENT_WALLET) {
      throw new Error('ERC8004Client: "agentWallet" is reserved — use setAgentWallet() instead');
    }
    const contract = this.getWriteContract(walletClient);
    const hexValue = stringToHex(value);
    return contract.write.setMetadata([agentId, key, hexValue], {
      account: walletClient.account, chain: this.chain,
    });
  }

  async setModelMetadata(walletClient: WalletClient, agentId: bigint, model: AgentModelMetadata): Promise<Hash[]> {
    const hashes: Hash[] = [];
    const entries: [string, string][] = [];
    if (model.model) entries.push([METADATA_KEYS.MODEL, model.model]);
    if (model.provider) entries.push([METADATA_KEYS.MODEL_PROVIDER, model.provider]);
    if (model.version) entries.push([METADATA_KEYS.VERSION, model.version]);
    if (model.framework) entries.push([METADATA_KEYS.FRAMEWORK, model.framework]);
    if (model.capabilities?.length) entries.push([METADATA_KEYS.CAPABILITIES, JSON.stringify(model.capabilities)]);

    for (const [key, val] of entries) {
      const hash = await this.setOnChainMetadata(walletClient, agentId, key, val);
      hashes.push(hash);
    }
    return hashes;
  }

  async readModelMetadata(agentId: bigint, blockNumber?: bigint): Promise<AgentModelMetadata | null> {
    const keys = [METADATA_KEYS.MODEL, METADATA_KEYS.MODEL_PROVIDER, METADATA_KEYS.VERSION, METADATA_KEYS.FRAMEWORK, METADATA_KEYS.CAPABILITIES];
    const values = await Promise.all(keys.map((k) => this.getOnChainMetadata(agentId, k, blockNumber)));
    const [modelHex, providerHex, versionHex, frameworkHex, capabilitiesHex] = values;

    if (!modelHex && !providerHex && !versionHex && !frameworkHex && !capabilitiesHex) return null;

    const result: AgentModelMetadata = {};
    if (modelHex) result.model = hexToString(modelHex);
    if (providerHex) result.provider = hexToString(providerHex);
    if (versionHex) result.version = hexToString(versionHex);
    if (frameworkHex) result.framework = hexToString(frameworkHex);
    if (capabilitiesHex) {
      try { result.capabilities = JSON.parse(hexToString(capabilitiesHex)); } catch { result.capabilities = []; }
    }
    return result;
  }

  async getAgentWallet(agentId: bigint): Promise<Address> {
    const contract = this.getReadContract();
    return contract.read.getAgentWallet([agentId]) as Promise<Address>;
  }

  async setAgentWallet(
    walletClient: WalletClient, agentId: bigint, newWallet: Address, deadline: bigint, signature: Hex,
  ): Promise<Hash> {
    if (!walletClient.account) throw new Error('ERC8004Client: WalletClient has no account');
    const contract = this.getWriteContract(walletClient);
    return contract.write.setAgentWallet([agentId, newWallet, deadline, signature], {
      account: walletClient.account, chain: this.chain,
    });
  }

  async unsetAgentWallet(walletClient: WalletClient, agentId: bigint): Promise<Hash> {
    if (!walletClient.account) throw new Error('ERC8004Client: WalletClient has no account');
    const contract = this.getWriteContract(walletClient);
    return contract.write.unsetAgentWallet([agentId], {
      account: walletClient.account, chain: this.chain,
    });
  }
}

// ─── Standalone helpers ───────────────────────────────────────────────────────

export function buildDataURI(registrationFile: AgentRegistrationFile): string {
  const payload = { ...registrationFile, type: REGISTRATION_FILE_TYPE };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `data:application/json;base64,${b64}`;
}

/** Decode inline JSON with a byte limit checked before base64 decoding. */
export function parseDataURI(uri: string, maxBytes: number = DEFAULT_METADATA_MAX_BYTES): AgentRegistrationFile {
  assertPositiveInteger(maxBytes, 'maxBytes');
  if (uri.startsWith(DATA_URI_PREFIX)) {
    if (uri.length - DATA_URI_PREFIX.length > Math.ceil(maxBytes / 3) * 4) {
      throw new Error('parseDataURI: Metadata exceeds maxBytes');
    }
    const binary = atob(uri.slice(DATA_URI_PREFIX.length));
    if (binary.length > maxBytes) throw new Error('parseDataURI: Metadata exceeds maxBytes');
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseBoundedJSON(json, maxBytes);
  }
  if (uri.startsWith('{')) return parseBoundedJSON(uri, maxBytes);
  throw new Error(`parseDataURI: Cannot parse URI scheme: ${uri.substring(0, 50)}`);
}

/**
 * Resolves bounded inline metadata without network access. External HTTPS URIs
 * require an explicitly trusted resolver; destination/DNS/redirect safety belongs
 * to that resolver, not this helper. It receives the original URI unchanged.
 */
export async function resolveAgentURI(uri: string, options: AgentURIResolutionOptions = {}): Promise<AgentRegistrationFile> {
  const maxBytes = options.maxBytes ?? DEFAULT_METADATA_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  assertPositiveInteger(maxBytes, 'maxBytes');
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new Error('resolveAgentURI: timeoutMs exceeds timer range');
  if (uri.startsWith('data:')) return parseDataURI(uri, maxBytes);
  if (!options.resolver) throw new Error('resolveAgentURI: External metadata resolution is disabled; supply a trusted resolver');
  if (!uri.startsWith('https://') || /[\u0000-\u0020\u007f\\]/.test(uri) || uri.length > 8192) {
    throw new Error('resolveAgentURI: External metadata must use an unambiguous HTTPS URI');
  }
  const url = new URL(uri);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('resolveAgentURI: HTTPS URI credentials are forbidden');
  }

  const resolver = options.resolver;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('resolveAgentURI: Metadata resolution timed out'));
        controller.abort();
      }, timeoutMs);
    });
    const json = await Promise.race([
      Promise.resolve().then(() => resolver(uri, { signal: controller.signal, maxBytes })),
      timeout,
    ]);
    return parseBoundedJSON(json, maxBytes);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function validateRegistrationFile(file: AgentRegistrationFile): string[] {
  const errors: string[] = [];
  if (file.type !== REGISTRATION_FILE_TYPE) errors.push(`type must be "${REGISTRATION_FILE_TYPE}"`);
  if (!file.name || typeof file.name !== 'string' || file.name.trim() === '') errors.push('name is required');
  if (!file.description || typeof file.description !== 'string') errors.push('description is required');
  if (file.services) {
    file.services.forEach((svc, i) => {
      if (!svc.name) errors.push(`services[${i}].name is required`);
      if (!svc.endpoint) errors.push(`services[${i}].endpoint is required`);
    });
  }
  if (file.registrations) {
    file.registrations.forEach((reg, i) => {
      if (reg.agentId === undefined) errors.push(`registrations[${i}].agentId is required`);
      if (!reg.agentRegistry) errors.push(`registrations[${i}].agentRegistry is required`);
    });
  }
  return errors;
}

export function formatAgentRegistry(chainId: number, registryAddress: Address): string {
  return `eip155:${chainId}:${registryAddress}`;
}

// ─── Internal utilities ───────────────────────────────────────────────────────

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ERC8004: ${name} must be a positive safe integer`);
}

function parseBoundedJSON(json: string, maxBytes: number): AgentRegistrationFile {
  if (typeof json !== 'string') throw new Error('resolveAgentURI: Resolver must return JSON text');
  if (json.length > maxBytes || new TextEncoder().encode(json).length > maxBytes) {
    throw new Error('ERC8004: Metadata exceeds maxBytes');
  }
  return JSON.parse(json) as AgentRegistrationFile;
}

function stringToHex(str: string): Hex {
  const bytes = new TextEncoder().encode(str);
  const hexStr = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return ('0x' + hexStr) as Hex;
}

function hexToString(hex: Hex): string {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(stripped.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeMetadataEntries(entries: Record<string, string>): MetadataEntry[] {
  return Object.entries(entries).map(([key, value]) => ({
    metadataKey: key,
    metadataValue: stringToHex(value),
  }));
}
