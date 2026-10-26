import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

const rpc = vi.hoisted(() => ({
  readContract: vi.fn(),
  getLogs: vi.fn(),
  getBlockNumber: vi.fn(),
  getChainId: vi.fn(),
}));

// Keep viem's real getContract adapter: ownership tests exercise readContract.
vi.mock('viem', async (importOriginal) => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => rpc,
}));

import {
  buildDataURI,
  ERC8004Client,
  parseDataURI,
  REGISTRATION_FILE_TYPE,
  resolveAgentURI,
  type AgentRegistrationFile,
} from './erc8004.js';

const OWNER: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_OWNER: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET: Address = '0xcccccccccccccccccccccccccccccccccccccccc';
const BLOCK = 100n;
const FILE: AgentRegistrationFile = {
  type: REGISTRATION_FILE_TYPE,
  name: 'Agent café ☕',
  description: 'Inline registration',
};

type ReadRequest = { functionName: string; args: readonly unknown[]; blockNumber?: bigint };
type EventQuery = { event: { name: string }; args: { owner?: Address; to?: Address } };
type ResolverContext = { signal: AbortSignal; maxBytes: number };

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getBlockNumber.mockResolvedValue(BLOCK);
  rpc.getChainId.mockResolvedValue(8453);
  rpc.getLogs.mockResolvedValue([]);
  rpc.readContract.mockImplementation(async ({ functionName }: ReadRequest) => {
    if (functionName === 'ownerOf') return OWNER;
    if (functionName === 'tokenURI') return buildDataURI(FILE);
    if (functionName === 'getAgentWallet') return WALLET;
    if (functionName === 'getMetadata') return '0x';
    throw new Error(`Unexpected read: ${functionName}`);
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(FILE))));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ERC-8004 registry metadata network boundary', () => {
  it.each([
    'http://127.0.0.1/private',
    'http://169.254.169.254/metadata',
    'https://[::1]/private',
    'https://10.0.0.1/private',
    'https://private-dns.example/registration.json',
    'https://agents.example/redirect-to-private',
  ])('rejects %s without making an implicit request', async (uri) => {
    await expect(resolveAgentURI(uri)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an external token URI available without automatically resolving it', async () => {
    const uri = 'https://agents.example/registration.json';
    rpc.readContract.mockImplementation(async ({ functionName }: ReadRequest) => {
      if (functionName === 'ownerOf') return OWNER;
      if (functionName === 'tokenURI') return uri;
      if (functionName === 'getAgentWallet') return WALLET;
      return '0x';
    });

    const identity = await new ERC8004Client({ chain: 'base' }).lookupAgentIdentity(42n);
    expect(identity).toMatchObject({ agentId: 42n, agentURI: uri, registrationFile: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves inline Unicode metadata locally', async () => {
    expect(await resolveAgentURI(buildDataURI(FILE))).toEqual(FILE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('delegates external resolution only to an explicitly supplied resolver', async () => {
    const uri = 'https://agents.example/registration.json';
    const resolver = vi.fn(async (_uri: string, _context: ResolverContext) => JSON.stringify(FILE));
    expect(await resolveAgentURI(uri, { resolver, maxBytes: 1024 })).toEqual(FILE);
    expect(resolver).toHaveBeenCalledWith(uri, {
      signal: expect.any(AbortSignal), maxBytes: 1024,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://agents.example/registration.json',
    'https://user:password@agents.example/registration.json',
    'https://agents.example/\nregistration.json',
    'ftp://agents.example/registration.json',
  ])('rejects unsupported or ambiguous external URI %s before delegation', async (uri) => {
    const resolver = vi.fn(async () => JSON.stringify(FILE));
    await expect(resolveAgentURI(uri, { resolver })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the explicitly configured client resolver for registry metadata', async () => {
    const uri = 'https://agents.example/registration.json';
    rpc.readContract.mockImplementation(async ({ functionName }: ReadRequest) => {
      if (functionName === 'ownerOf') return OWNER;
      if (functionName === 'tokenURI') return uri;
      if (functionName === 'getAgentWallet') return WALLET;
      return '0x';
    });
    const resolver = vi.fn(async () => JSON.stringify(FILE));
    const client = new ERC8004Client({ chain: 'base', uriResolution: { resolver } });
    expect((await client.lookupAgentIdentity(42n)).registrationFile).toEqual(FILE);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns unavailable metadata when the trusted resolver refuses its destination', async () => {
    rpc.readContract.mockImplementation(async ({ functionName }: ReadRequest) => {
      if (functionName === 'ownerOf') return OWNER;
      if (functionName === 'tokenURI') return 'https://private-dns.example/registration.json';
      if (functionName === 'getAgentWallet') return WALLET;
      return '0x';
    });
    const resolver = async () => { throw new Error('Host policy rejected private DNS answer'); };
    const client = new ERC8004Client({ chain: 'base', uriResolution: { resolver } });
    expect((await client.lookupAgentIdentity(42n)).registrationFile).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ERC-8004 metadata resource bounds', () => {
  it('rejects oversized default data URIs before base64 decoding', () => {
    const oversized = buildDataURI({ ...FILE, description: 'x'.repeat(256 * 1024) });
    const decode = vi.spyOn(globalThis, 'atob');
    expect(() => parseDataURI(oversized)).toThrow(/size|bytes|large/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it('caps custom data URI decoding before allocating decoded text', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    await expect(resolveAgentURI(buildDataURI(FILE), { maxBytes: 16 })).rejects.toThrow(/size|bytes|large/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes for legacy inline JSON', () => {
    const json = JSON.stringify({ ...FILE, description: '☕'.repeat(20) });
    const byteCount = new TextEncoder().encode(json).length;
    expect(byteCount).toBeGreaterThan(json.length);
    expect(() => parseDataURI(json, byteCount - 1)).toThrow(/size|bytes|large/i);
    expect(parseDataURI(json, byteCount)).toEqual(JSON.parse(json));
  });

  it('caps UTF-8 text returned by an external resolver', async () => {
    const resolver = async () => JSON.stringify({ ...FILE, description: '☕'.repeat(200) });
    await expect(resolveAgentURI('https://agents.example/registration.json', {
      resolver, maxBytes: 512,
    })).rejects.toThrow(/size|bytes|large/i);
  });

  it('ends metadata resolution and aborts after a deadline even if the resolver ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const resolver = (_uri: string, context: ResolverContext): Promise<string> => {
      signal = context.signal;
      return new Promise(() => {});
    };
    const resolution = resolveAgentURI('https://agents.example/registration.json', { resolver, timeoutMs: 10 });
    const settled = resolution.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(10);
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/timed out/i);
    expect(signal?.aborted).toBe(true);
  });

  it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid byte limit %s before delegation', async (maxBytes) => {
    const resolver = vi.fn(async () => JSON.stringify(FILE));
    await expect(resolveAgentURI('https://agents.example/registration.json', { resolver, maxBytes })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid timeout %s before delegation', async (timeoutMs) => {
    const resolver = vi.fn(async () => JSON.stringify(FILE));
    await expect(resolveAgentURI('https://agents.example/registration.json', { resolver, timeoutMs })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('ERC-8004 current owner lookup', () => {
  function registered(agentId: bigint, blockNumber: bigint, logIndex = 0) {
    return { args: { agentId, owner: OWNER }, blockNumber, logIndex };
  }

  function transferred(tokenId: bigint, blockNumber: bigint, logIndex = 0) {
    return { args: { tokenId, from: OTHER_OWNER, to: OWNER }, blockNumber, logIndex };
  }

  function discover(registrations: ReturnType<typeof registered>[], transfers: ReturnType<typeof transferred>[] = []) {
    rpc.getLogs.mockImplementation(async ({ event }: EventQuery) => event.name === 'Registered' ? registrations : transfers);
  }

  it('returns no identity for an owner whose registered token transferred away', async () => {
    discover([registered(42n, 1n)]);
    rpc.readContract.mockImplementation(async ({ functionName }: ReadRequest) => {
      if (functionName === 'ownerOf') return OTHER_OWNER;
      if (functionName === 'tokenURI') return buildDataURI(FILE);
      if (functionName === 'getAgentWallet') return WALLET;
      return '0x';
    });
    expect(await new ERC8004Client({ chain: 'base' }).lookupAgentByOwner(OWNER)).toBeNull();
    expect(rpc.readContract.mock.calls.some(([request]) => request.functionName === 'tokenURI')).toBe(false);
  });

  it('discovers a transferred-in token without a Registered event for its new owner', async () => {
    discover([], [transferred(42n, 2n)]);
    const identity = await new ERC8004Client({ chain: 'base' }).lookupAgentByOwner(OWNER);
    expect(identity).toMatchObject({ agentId: 42n, owner: OWNER, registrationFile: FILE });
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ name: 'Transfer' }), args: { to: OWNER },
    }));
  });

  it('continues to an older registration when the newest token belongs to someone else', async () => {
    discover([registered(1n, 1n), registered(2n, 2n)]);
    rpc.readContract.mockImplementation(async ({ functionName, args }: ReadRequest) => {
      if (functionName === 'ownerOf') return args[0] === 2n ? OTHER_OWNER : OWNER;
      if (functionName === 'tokenURI') return buildDataURI(FILE);
      if (functionName === 'getAgentWallet') return WALLET;
      return '0x';
    });
    expect((await new ERC8004Client({ chain: 'base' }).lookupAgentByOwner(OWNER))?.agentId).toBe(1n);
  });

  it('orders registration and inbound transfer candidates by latest ownership event', async () => {
    discover([registered(1n, 4n)], [transferred(2n, 5n)]);
    expect((await new ERC8004Client({ chain: 'base' }).lookupAgentByOwner(OWNER))?.agentId).toBe(2n);
  });

  it('uses one block snapshot for discovery, ownership, identity, and model metadata', async () => {
    discover([registered(42n, 1n)]);
    const client = new ERC8004Client({ chain: 'base' });
    const identity = await client.lookupAgentByOwner(OWNER, 10n);
    expect(identity?.owner).toBe(OWNER);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
    for (const [request] of rpc.getLogs.mock.calls) {
      expect(request).toMatchObject({ fromBlock: 10n, toBlock: BLOCK });
    }
    for (const [request] of rpc.readContract.mock.calls) {
      expect(request.blockNumber).toBe(BLOCK);
    }
  });

  it('compares current ownership case-insensitively', async () => {
    discover([registered(42n, 1n)]);
    const mixedCaseOwner = `0x${OWNER.slice(2).toUpperCase()}` as Address;
    expect((await new ERC8004Client({ chain: 'base' }).lookupAgentByOwner(mixedCaseOwner))?.agentId).toBe(42n);
  });
});

describe('readAgentBinding is bound to the RPC endpoint chain (Codex round 5)', () => {
  it('reads the binding when the endpoint serves the configured chain', async () => {
    const binding = await new ERC8004Client({ chain: 'base' }).readAgentBinding(7n);
    expect(binding).toMatchObject({ owner: OWNER, agentWallet: WALLET, blockNumber: BLOCK });
  });

  it('refuses an endpoint for another chain before any registry read', async () => {
    rpc.getChainId.mockResolvedValue(1); // same registry address exists on Ethereum
    await expect(new ERC8004Client({ chain: 'base' }).readAgentBinding(7n)).rejects.toThrow(/RPC serves chain 1/);
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
});

describe('readAgentBinding re-checks the chain after its reads (Codex round 6)', () => {
  it('discards a snapshot read while the endpoint switched networks', async () => {
    rpc.getChainId.mockResolvedValueOnce(8453).mockResolvedValueOnce(1);
    await expect(new ERC8004Client({ chain: 'base' }).readAgentBinding(7n)).rejects.toThrow(/after the binding read/);
  });
});
