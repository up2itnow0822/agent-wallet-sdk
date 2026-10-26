/**
 * SolanaBridgeModule — CCTP V2 cross-chain USDC bridge between EVM chains and Solana.
 *
 * Uses Circle's Cross-Chain Transfer Protocol (CCTP) V2 for trustless USDC transfers.
 * EVM side uses viem; Solana side uses @solana/web3.js as an optional peer dependency.
 *
 * Sources:
 *   - Circle CCTP Solana docs: https://developers.circle.com/cctp/docs/solana
 *   - Solana USDC mint: https://solana.com/ecosystem/usdc
 *   - CCTP domain IDs: https://developers.circle.com/cctp/references/contract-addresses
 */

import {
  pollCircleAttestation,
  assertBurnTerms,
  isDefinitelyNotBroadcast,
  BURN_SUBMISSION_UNKNOWN_HINT,
  type CctpAttestedMessage,
  type AttestationSelector,
} from './attestation.js';
import { boundedFetch, parseBoundedJson } from '../net/bounded-fetch.js';
import {
  createPublicClient,
  http,
  keccak256,
  pad,
  getContract,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base, mainnet, optimism, arbitrum, polygon, avalanche, linea } from 'viem/chains';
import { TokenMessengerV2Abi, MessageTransmitterV2Abi, ERC20BridgeAbi } from './abis.js';
import {
  CCTP_DOMAIN_IDS,
  USDC_CONTRACT,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2 as MESSAGE_TRANSMITTER_V2_MAP,
  CIRCLE_ATTESTATION_API,
  MAX_ATTESTATION_POLLS,
  ATTESTATION_POLL_INTERVAL_MS,
  FINALITY_THRESHOLD,
  type EVMBridgeChain,
} from './types.js';

// ─── Solana Constants ───

/** Solana CCTP domain ID */
export const SOLANA_CCTP_DOMAIN = 5;

/** Native USDC mint on Solana Mainnet */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as const;

/**
 * Solana CCTP V2 TokenMessengerMinterV2 program address.
 * This is the V2 program (not V1 CCTPiPYP...). The V2 program combines
 * TokenMessengerV2 + TokenMinterV2 into a single program.
 * Source: https://developers.circle.com/cctp/references/solana-programs
 * Verified: https://github.com/circlefin/solana-cctp-contracts (programs/v2)
 */
export const SOLANA_TOKEN_MESSENGER = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe' as const;

/**
 * Solana CCTP V2 MessageTransmitterV2 program address.
 * This is the V2 program (not V1 CCTPmbSD...).
 * Source: https://developers.circle.com/cctp/references/solana-programs
 * Verified: https://github.com/circlefin/solana-cctp-contracts (programs/v2)
 */
export const SOLANA_MESSAGE_TRANSMITTER = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC' as const;

/** Default Solana Mainnet RPC endpoint */
export const SOLANA_DEFAULT_RPC = 'https://api.mainnet-beta.solana.com' as const;

/** SPL Token program (classic) — owner of USDC token accounts. */
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as const;

/** Genesis hash of Solana mainnet-beta (the cluster SOLANA_USDC_MINT lives on). */
export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' as const;

// ─── Viem chain definitions for EVM side ───

const VIEM_CHAINS: Record<EVMBridgeChain, any> = {
  base,
  ethereum:   mainnet,
  optimism,
  arbitrum,
  polygon,
  avalanche,
  linea,
  unichain:   { id: 130, name: 'Unichain',   nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } } },
  sonic:      { id: 146, name: 'Sonic',       nativeCurrency: { name: 'S',   symbol: 'S',   decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.soniclabs.com'] } } },
  worldchain: { id: 480, name: 'World Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://worldchain-mainnet.g.alchemy.com/public'] } } },
};

// ─── Helpers ───

/**
 * Encode a Solana base58 public key as a 32-byte hex buffer for CCTP.
 * CCTP requires the mint recipient to be a 32-byte zero-padded value.
 * For Solana, this is the base58-decoded public key (already 32 bytes).
 */
export function solanaPubkeyToBytes32(base58Address: string): Hex {
  if (typeof base58Address !== 'string' || base58Address.length < 32 || base58Address.length > 44) {
    throw new Error('SolanaBridge: Solana address must be a 32–44 character base58 string.');
  }
  // We manually decode base58 here to avoid requiring the dependency at import time.
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = new Uint8Array(32);
  let intVal = 0n;
  for (const char of base58Address) {
    const digit = BigInt(ALPHABET.indexOf(char));
    if (digit < 0n) throw new Error(`SolanaBridge: Invalid base58 character '${char}' in address.`);
    intVal = intVal * 58n + digit;
  }
  // Write to 32-byte big-endian buffer
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(intVal & 0xffn);
    intVal >>= 8n;
  }
  if (intVal !== 0n) throw new Error(`SolanaBridge: Address value overflows 32 bytes.`);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const out = `0x${hex}` as Hex;
  // Canonical form only: the decoded key must re-encode to exactly the input.
  if (bytes32ToSolanaPubkey(out) !== base58Address) {
    throw new Error('SolanaBridge: Solana address is not in canonical base58 form.');
  }
  return out;
}

/**
 * Decode a 32-byte hex buffer back to a Solana base58 public key.
 * Used when interpreting Solana→EVM message recipient fields.
 */
export function bytes32ToSolanaPubkey(bytes32: Hex): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const hex = bytes32.startsWith('0x') ? bytes32.slice(2) : bytes32;
  if (hex.length !== 64) throw new Error(`SolanaBridge: Expected 32-byte hex (64 chars), got ${hex.length}.`);
  let intVal = BigInt('0x' + hex);
  let result = '';
  while (intVal > 0n) {
    const rem = Number(intVal % 58n);
    intVal /= 58n;
    result = ALPHABET[rem] + result;
  }
  // Each leading zero byte is a leading '1' in base58.
  let leadingZeros = 0;
  while (leadingZeros < 32 && hex.slice(leadingZeros * 2, leadingZeros * 2 + 2) === '00') leadingZeros++;
  return '1'.repeat(leadingZeros) + result;
}

// ─── Destination verification (EVM→Solana) ───

export interface VerifySolanaUsdcAccountOptions {
  rpcUrl?: string;
  /** When set, the token account must be owned by this wallet. */
  owner?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function solanaRpc(rpcUrl: string, method: string, params: unknown[], opts: VerifySolanaUsdcAccountOptions): Promise<unknown> {
  const res = await boundedFetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, { timeoutMs: opts.timeoutMs ?? 15_000, maxBytes: 64 * 1024, fetchImpl: opts.fetchImpl });
  if (!res.ok) throw new Error(`Solana RPC ${method} returned HTTP ${res.status}`);
  const body = parseBoundedJson(res.text, `Solana RPC ${method}`) as { result?: unknown; error?: { message?: string } };
  if (!body || typeof body !== 'object') throw new Error(`Solana RPC ${method} returned a non-object`);
  if (body.error) throw new Error(`Solana RPC ${method} error: ${String(body.error.message ?? 'unknown').slice(0, 200)}`);
  return body.result;
}

/**
 * Require that `tokenAccount` is an existing, initialized SPL token account
 * for mainnet USDC (the CCTP mint recipient must be a token account, not a
 * wallet). Also binds the RPC to mainnet-beta by genesis hash. Throws otherwise.
 */
export async function verifySolanaUsdcTokenAccount(
  tokenAccount: string,
  options: VerifySolanaUsdcAccountOptions = {},
): Promise<void> {
  solanaPubkeyToBytes32(tokenAccount); // canonical base58, 32 bytes
  if (options.owner !== undefined) solanaPubkeyToBytes32(options.owner);
  const rpcUrl = options.rpcUrl ?? SOLANA_DEFAULT_RPC;
  // The cluster check brackets the account read: a load-balanced RPC that
  // switches clusters in between cannot vouch for the recipient on mainnet.
  const assertMainnet = async (when: string) => {
    const genesis = await solanaRpc(rpcUrl, 'getGenesisHash', [], options);
    if (genesis !== SOLANA_MAINNET_GENESIS_HASH) {
      throw new Error(`Solana RPC is not mainnet-beta ${when} (genesis ${String(genesis)})`);
    }
  };
  await assertMainnet('before the recipient lookup');
  const result = await solanaRpc(rpcUrl, 'getAccountInfo', [tokenAccount, { encoding: 'jsonParsed', commitment: 'finalized' }], options) as {
    value?: { owner?: unknown; data?: { program?: unknown; parsed?: { type?: unknown; info?: Record<string, unknown> } } } | null;
  };
  await assertMainnet('after the recipient lookup');
  const value = result?.value;
  if (!value) throw new Error(`Solana account ${tokenAccount} does not exist; create the recipient's USDC token account first`);
  if (value.owner !== SPL_TOKEN_PROGRAM_ID) throw new Error(`Solana account ${tokenAccount} is not an SPL Token program account`);
  const parsed = value.data?.parsed;
  const info = parsed?.info;
  if (parsed?.type !== 'account' || !info) throw new Error(`Solana account ${tokenAccount} is not a token account (pass the USDC token account, not the wallet)`);
  if (info.mint !== SOLANA_USDC_MINT) throw new Error(`Solana token account ${tokenAccount} is not for USDC`);
  if (info.state !== 'initialized') throw new Error(`Solana token account ${tokenAccount} is not initialized`);
  if (options.owner !== undefined && info.owner !== options.owner) {
    throw new Error(`Solana token account ${tokenAccount} is not owned by ${options.owner}`);
  }
}

// ─── EVM→Solana Bridge ───

export interface EVMToSolanaOptions {
  /**
   * Solana USDC *token account* (base58) that receives the mint — typically the
   * recipient's associated token account. Verified on-chain before any approval
   * or burn: it must exist, be initialized, and hold mainnet USDC.
   */
  solanaRecipient: string;
  /** Optional: the wallet that must own `solanaRecipient`. */
  solanaRecipientOwner?: string;
  /** Solana RPC used for recipient verification (default: mainnet-beta). */
  solanaRpcUrl?: string;
  /** EVM source chain. Defaults to 'base'. */
  fromChain?: EVMBridgeChain;
  /** Optional EVM RPC URL override. */
  evmRpcUrl?: string;
  /** Finality threshold: FAST (0) or FINALIZED (1000). Default: FAST. */
  minFinalityThreshold?: number;
  /** Max bridge fee in USDC base units. Default: 0 (no fee). */
  maxFee?: bigint;
  /** Circle IRIS API URL override. */
  attestationApiUrl?: string;
}

/** Immutable state needed to finish an EVM→Solana transfer after its burn was broadcast. */
export interface SolanaBridgeRecovery {
  readonly burnTxHash: Hash;
  readonly fromChain: EVMBridgeChain;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly amount: bigint;
  readonly mintRecipient: Hex;
  readonly burnToken: Address;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly messageBytes?: Hex;
}

/** Immutable state needed to reconcile a Solana→EVM mint. */
export interface SolanaMintRecovery {
  readonly toChain: EVMBridgeChain;
  readonly recipient: Address;
  readonly attestedMessage: Hex;
  readonly attestation: Hex;
  readonly nonce: Hex;
  readonly mintTxHash?: Hash;
}

export interface EVMToSolanaResult {
  /** EVM burn transaction hash */
  burnTxHash: Hash;
  /** keccak256 of messageBytes (the attested V2 message) */
  messageHash: Hex;
  /** keccak256 of the source MessageSent bytes (pre-attestation, nonce zero) */
  sourceMessageHash: Hex;
  /** Circle-assigned CCTP V2 event nonce, when returned */
  eventNonce?: Hex;
  /** Attested CCTP message bytes (for manual receiveMessage on Solana) */
  messageBytes: Hex;
  /** Circle attestation signature (for receiveMessage on Solana) */
  attestation: Hex;
  /** The Solana CCTP domain (5) */
  destinationDomain: number;
  /** Amount bridged in USDC base units */
  amount: bigint;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
}

/**
 * Bridge USDC from an EVM chain to Solana using CCTP V2.
 *
 * This function handles the EVM burn side and attestation polling.
 * The Solana receive side must be completed by calling `receiveMessageOnSolana()`
 * or by the Solana recipient manually submitting the message and attestation
 * to the Solana MessageTransmitter program.
 *
 * @param walletClient - Viem WalletClient with a signer attached (for EVM)
 * @param amount - Amount to bridge in USDC base units (6 decimals, e.g. 1_000_000n = 1 USDC)
 * @param options - Bridge options including solanaRecipient (required)
 * @returns Burn tx hash, attestation, and message bytes for Solana receive
 */
export async function bridgeEVMToSolana(
  walletClient: WalletClient,
  amount: bigint,
  options: EVMToSolanaOptions,
): Promise<EVMToSolanaResult> {
  const startMs = Date.now();
  const fromChain = options.fromChain ?? 'base';
  const minFinalityThreshold = options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
  const maxFee = options.maxFee ?? 0n;
  const attestationApiUrl = options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

  if (!walletClient.account) {
    throw new SolanaBridgeError('NO_WALLET_CLIENT', 'WalletClient must have an account attached.');
  }
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new SolanaBridgeError('INVALID_AMOUNT', `Bridge amount must be > 0. Received: ${amount}.`);
  }
  if (!options.solanaRecipient) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', 'solanaRecipient (base58 Solana USDC token account) is required.');
  }

  // Encode Solana address as 32-byte CCTP mint recipient (canonical base58 only)
  let mintRecipient: Hex;
  try {
    mintRecipient = solanaPubkeyToBytes32(options.solanaRecipient);
  } catch (err) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', (err as Error).message);
  }
  // Verify BEFORE approval/burn that the recipient can actually receive the mint.
  try {
    await verifySolanaUsdcTokenAccount(options.solanaRecipient, {
      rpcUrl: options.solanaRpcUrl,
      owner: options.solanaRecipientOwner,
    });
  } catch (err) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', `Solana recipient verification failed: ${(err as Error).message}.`);
  }

  // Zero destinationCaller = any relayer can submit on Solana
  const destinationCaller = pad('0x0' as Hex, { size: 32 });

  const publicClient = createPublicClient({
    chain: VIEM_CHAINS[fromChain],
    transport: http(options.evmRpcUrl),
  }) as PublicClient;

  const account = walletClient.account;
  const usdcAddress = USDC_CONTRACT[fromChain];
  const messengerAddress = TOKEN_MESSENGER_V2[fromChain];

  // Approve USDC if needed
  const usdcRead = getContract({ address: usdcAddress, abi: ERC20BridgeAbi, client: publicClient });
  const currentAllowance = await usdcRead.read.allowance([account.address, messengerAddress]) as bigint;
  if (currentAllowance < amount) {
    const usdcWrite = getContract({
      address: usdcAddress,
      abi: ERC20BridgeAbi,
      client: { public: publicClient, wallet: walletClient },
    });
    const approveTxHash = await usdcWrite.write.approve([messengerAddress, amount], {
      account,
      chain: VIEM_CHAINS[fromChain],
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status !== 'success') {
      throw new SolanaBridgeError('INSUFFICIENT_ALLOWANCE', `USDC approve failed (tx: ${approveTxHash}).`);
    }
  }

  // Burn USDC via CCTP V2 depositForBurn targeting Solana domain
  const messenger = getContract({
    address: messengerAddress,
    abi: TokenMessengerV2Abi,
    client: { public: publicClient, wallet: walletClient },
  });

  let burnTxHash: Hash;
  try {
    burnTxHash = await messenger.write.depositForBurn(
      [amount, SOLANA_CCTP_DOMAIN, mintRecipient, usdcAddress, destinationCaller, maxFee, minFinalityThreshold],
      { account, chain: VIEM_CHAINS[fromChain] },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isDefinitelyNotBroadcast(err)) {
      throw new SolanaBridgeError('BURN_FAILED', `CCTP depositForBurn to Solana failed: ${msg}.`);
    }
    throw new SolanaBridgeError('BURN_SUBMISSION_UNKNOWN', `CCTP depositForBurn to Solana outcome unknown: ${msg}. ${BURN_SUBMISSION_UNKNOWN_HINT}`);
  }

  // From here the burn hash is known: every failure carries immutable recovery
  // state, and resumption never calls depositForBurn again.
  const recovery: SolanaBridgeRecovery = Object.freeze({
    burnTxHash,
    fromChain,
    sourceDomain: CCTP_DOMAIN_IDS[fromChain],
    destinationDomain: SOLANA_CCTP_DOMAIN,
    amount,
    mintRecipient,
    burnToken: usdcAddress,
    maxFee,
    minFinalityThreshold,
  });
  return completeEVMToSolana(recovery, publicClient, attestationApiUrl, startMs);
}

/**
 * Resume an EVM→Solana transfer from its recovery state (e.g. after a crash or
 * a post-broadcast error). Reads the known burn receipt, re-verifies its terms
 * and polls the attestation. Never submits another burn.
 */
export async function resumeEVMToSolana(
  recovery: SolanaBridgeRecovery,
  options: { evmRpcUrl?: string; attestationApiUrl?: string } = {},
): Promise<EVMToSolanaResult> {
  const publicClient = createPublicClient({
    chain: VIEM_CHAINS[recovery.fromChain],
    transport: http(options.evmRpcUrl),
  }) as PublicClient;
  return completeEVMToSolana(recovery, publicClient, options.attestationApiUrl ?? CIRCLE_ATTESTATION_API, Date.now());
}

async function completeEVMToSolana(
  recovery: SolanaBridgeRecovery,
  publicClient: PublicClient,
  attestationApiUrl: string,
  startMs: number,
): Promise<EVMToSolanaResult> {
  const withRecovery = (code: SolanaBridgeErrorCode, message: string, extra: Partial<SolanaBridgeRecovery> = {}): SolanaBridgeError => {
    const e = new SolanaBridgeError(code, `${message} Recovery: resumeEVMToSolana(error.recovery) — never burn again.`);
    e.recovery = Object.freeze({ ...recovery, ...extra });
    return e;
  };

  let messageBytes: Hex;
  let messageHash: Hex;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: recovery.burnTxHash });
    if (receipt.status !== 'success') {
      // A reverted burn moved no funds; this is a definite failure.
      throw new SolanaBridgeError('BURN_FAILED', `depositForBurn transaction reverted (tx: ${recovery.burnTxHash}).`);
    }
    ({ messageBytes, messageHash } = extractMessageSent(receipt.logs, MESSAGE_TRANSMITTER_V2_MAP[recovery.fromChain]));
    assertBurnTerms(messageBytes, {
      sourceDomain: recovery.sourceDomain,
      destinationDomain: recovery.destinationDomain,
      burnToken: recovery.burnToken,
      mintRecipient: recovery.mintRecipient,
      amount: recovery.amount,
      maxFee: recovery.maxFee,
      minFinalityThreshold: recovery.minFinalityThreshold,
    });
  } catch (err: unknown) {
    if (err instanceof SolanaBridgeError && err.code === 'BURN_FAILED') throw err;
    throw withRecovery('BURN_UNCONFIRMED', `Burn ${recovery.burnTxHash} was submitted but could not be confirmed: ${err instanceof Error ? err.message : String(err)}.`);
  }

  let attested: CctpAttestedMessage;
  try {
    attested = await pollForAttestation(recovery.burnTxHash, recovery.sourceDomain, attestationApiUrl, messageBytes);
  } catch (err: unknown) {
    const code = err instanceof SolanaBridgeError ? err.code : 'ATTESTATION_ERROR';
    throw withRecovery(code, err instanceof Error ? err.message : String(err), { messageBytes });
  }

  try {
    assertBurnTerms(attested.message, {
      sourceDomain: recovery.sourceDomain,
      destinationDomain: recovery.destinationDomain,
      burnToken: recovery.burnToken,
      mintRecipient: recovery.mintRecipient,
      amount: recovery.amount,
      maxFee: recovery.maxFee,
      minFinalityThreshold: recovery.minFinalityThreshold,
    });
  } catch (err) {
    throw withRecovery('ATTESTATION_ERROR', `Attested message does not match the burn: ${(err as Error).message}.`, { messageBytes });
  }

  return {
    burnTxHash: recovery.burnTxHash,
    // Hash of the attested bytes returned below (nonce filled in by Circle).
    messageHash: keccak256(attested.message),
    sourceMessageHash: messageHash,
    eventNonce: attested.eventNonce,
    // Circle's attested V2 message (nonce filled in) is what Solana receiveMessage needs.
    messageBytes: attested.message,
    attestation: attested.attestation,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    amount: recovery.amount,
    elapsedMs: Date.now() - startMs,
  };
}

// ─── Solana→EVM Bridge ───

export interface SolanaToEVMOptions {
  /** EVM destination chain */
  toChain: EVMBridgeChain;
  /** Optional EVM destination RPC URL override */
  evmRpcUrl?: string;
  /** EVM recipient address. Defaults to the EVM walletClient's account address. */
  evmRecipient?: Address;
  /** Circle IRIS API URL override */
  attestationApiUrl?: string;
  /** Solana RPC URL override */
  solanaRpcUrl?: string;
}

export interface SolanaToEVMBurnParams {
  /** Raw CCTP message bytes from Solana burn transaction */
  messageBytes: Hex;
  /** Circle message hash */
  messageHash: Hex;
  /** Source domain (should be SOLANA_CCTP_DOMAIN = 5) */
  sourceDomain: number;
  /** Solana burn transaction signature (base58). Required: Circle V2 looks attestations up by tx (#44). */
  burnTxSignature: string;
  /** Only for identical burns batched in one tx: Circle eventNonce of the wanted message. */
  eventNonce?: string;
  /** Only for identical burns batched in one tx: index among identical messages. */
  messageIndex?: number;
}

export interface SolanaToEVMResult {
  /** EVM mint transaction hash */
  mintTxHash: Hash;
  /** Amount received in USDC base units */
  amount: bigint;
  /** EVM destination chain */
  toChain: EVMBridgeChain;
  /** EVM recipient address */
  recipient: Address;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
}

/**
 * Complete the Solana→EVM bridge by polling for Circle's attestation and minting on EVM.
 *
 * The caller is responsible for initiating the Solana burn via the Solana
 * CCTP MessageTransmitter and passing the resulting messageBytes + messageHash here.
 *
 * @param walletClient - Viem WalletClient (for EVM signing)
 * @param burnParams - Message bytes and hash from the Solana burn transaction
 * @param options - Destination chain and optional overrides
 */
export async function receiveFromSolanaOnEVM(
  walletClient: WalletClient,
  burnParams: SolanaToEVMBurnParams,
  options: SolanaToEVMOptions,
): Promise<SolanaToEVMResult> {
  const startMs = Date.now();
  const { toChain, evmRpcUrl } = options;
  const attestationApiUrl = options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

  if (!walletClient.account) {
    throw new SolanaBridgeError('NO_WALLET_CLIENT', 'WalletClient must have an account attached.');
  }
  if (!(toChain in MESSAGE_TRANSMITTER_V2_MAP)) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', `Unsupported destination chain ${String(toChain)}.`);
  }

  const account = walletClient.account;
  const requestedRecipient = (options.evmRecipient ?? account.address) as Address;

  if (!burnParams.burnTxSignature) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', 'burnParams.burnTxSignature is required (Circle CCTP V2 attestation lookup is by burn transaction).');
  }
  // Bind the caller's burn description to the message before any network call.
  if (burnParams.sourceDomain !== SOLANA_CCTP_DOMAIN) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', `burnParams.sourceDomain must be ${SOLANA_CCTP_DOMAIN} (Solana).`);
  }
  if (typeof burnParams.messageHash !== 'string' || keccak256(burnParams.messageBytes).toLowerCase() !== burnParams.messageHash.toLowerCase()) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', 'burnParams.messageHash does not match keccak256(burnParams.messageBytes).');
  }
  const expectedTerms = solanaToEvmTerms(toChain, requestedRecipient);
  try {
    assertBurnTerms(burnParams.messageBytes, expectedTerms);
  } catch (err) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', `Solana burn message does not match this receive: ${(err as Error).message}.`);
  }

  const attested = await pollForAttestation(
    burnParams.burnTxSignature,
    burnParams.sourceDomain,
    attestationApiUrl,
    burnParams.messageBytes,
    { eventNonce: burnParams.eventNonce, index: burnParams.messageIndex },
  );

  // Derive everything we report from the validated, attested bytes.
  let decoded;
  try {
    decoded = assertBurnTerms(attested.message, expectedTerms);
  } catch (err) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', `Attested message does not match the Solana burn: ${(err as Error).message}.`);
  }
  return mintAttested(walletClient, {
    toChain, evmRpcUrl, recipient: requestedRecipient, attested, decoded, startMs,
  });
}

/** Terms every Solana→EVM USDC message for `toChain` / `recipient` must carry. */
function solanaToEvmTerms(toChain: EVMBridgeChain, recipient: Address) {
  return {
    sourceDomain: SOLANA_CCTP_DOMAIN,
    destinationDomain: CCTP_DOMAIN_IDS[toChain],
    burnToken: solanaPubkeyToBytes32(SOLANA_USDC_MINT),
    sender: solanaPubkeyToBytes32(SOLANA_TOKEN_MESSENGER),
    mintRecipient: recipient,
  };
}

/**
 * Resume a Solana→EVM mint from the frozen `error.mintRecovery` of an earlier
 * MINT_SUBMISSION_UNKNOWN / MINT_UNCONFIRMED failure. Re-validates the
 * attested bytes against the recovery's chain and recipient, then resolves a
 * retained `mintTxHash` BEFORE any new write: a successful receipt (with the
 * nonce consumed) returns the result; a pending or unreadable one throws
 * MINT_UNCONFIRMED again without submitting; only a reverted one proceeds to
 * the usedNonces check and a new receiveMessage. A recovery without a hash
 * (MINT_SUBMISSION_UNKNOWN) mints again only with
 * `originalSubmissionReconciled: true`.
 */
export async function resumeSolanaToEVM(
  walletClient: WalletClient,
  recovery: SolanaMintRecovery,
  options: {
    evmRpcUrl?: string;
    /**
     * Required to mint again from a recovery WITHOUT `mintTxHash`
     * (MINT_SUBMISSION_UNKNOWN): the earlier receiveMessage may have been
     * broadcast without returning a hash and may still be pending. Set it only
     * after reconciling that submission (e.g. no pending transaction from this
     * account). A consumed nonce is always reported as MINT_ALREADY_RECEIVED.
     */
    originalSubmissionReconciled?: boolean;
  } = {},
): Promise<SolanaToEVMResult> {
  const startMs = Date.now();
  if (!walletClient.account) {
    throw new SolanaBridgeError('NO_WALLET_CLIENT', 'WalletClient must have an account attached.');
  }
  const toChain = recovery?.toChain;
  if (!toChain || !Object.prototype.hasOwnProperty.call(MESSAGE_TRANSMITTER_V2_MAP, toChain)) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', `Unsupported destination chain ${String(toChain)}.`);
  }
  if (typeof recovery.attestation !== 'string' || !/^0x[0-9a-fA-F]+$/.test(recovery.attestation)) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', 'mintRecovery.attestation is not hex.');
  }
  if (recovery.mintTxHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(recovery.mintTxHash)) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', 'mintRecovery.mintTxHash is not a transaction hash.');
  }
  let decoded;
  try {
    decoded = assertBurnTerms(recovery.attestedMessage, solanaToEvmTerms(toChain, recovery.recipient));
  } catch (err) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', `mintRecovery message does not match its chain/recipient: ${(err as Error).message}.`);
  }
  if (typeof recovery.nonce !== 'string' || decoded.nonce.toLowerCase() !== recovery.nonce.toLowerCase()) {
    throw new SolanaBridgeError('ATTESTATION_ERROR', 'mintRecovery.nonce does not match the attested message.');
  }
  return mintAttested(walletClient, {
    toChain,
    evmRpcUrl: options.evmRpcUrl,
    recipient: recovery.recipient,
    attested: { message: recovery.attestedMessage, attestation: recovery.attestation },
    decoded,
    startMs,
    priorMintTxHash: recovery.mintTxHash,
    holdUnreconciled: recovery.mintTxHash === undefined && options.originalSubmissionReconciled !== true,
  });
}

/** Mint an attested Solana→EVM message, reconciling any retained mint first. */
async function mintAttested(
  walletClient: WalletClient,
  ctx: {
    toChain: EVMBridgeChain;
    evmRpcUrl?: string;
    recipient: Address;
    attested: { message: Hex; attestation: Hex };
    decoded: ReturnType<typeof assertBurnTerms>;
    startMs: number;
    priorMintTxHash?: Hash;
    /** Hashless ambiguous submission not yet reconciled: never write. */
    holdUnreconciled?: boolean;
  },
): Promise<SolanaToEVMResult> {
  const { toChain, evmRpcUrl, recipient, attested, decoded, startMs } = ctx;
  const account = walletClient.account!;
  const mintedAmount = decoded.amount - decoded.feeExecuted;

  // Submit receiveMessage on EVM
  const transmitterAddress = MESSAGE_TRANSMITTER_V2_MAP[toChain];
  const destChain = VIEM_CHAINS[toChain];
  const destPublicClient = createPublicClient({ chain: destChain, transport: http(evmRpcUrl) }) as PublicClient;

  const transmitter = getContract({
    address: transmitterAddress,
    abi: MessageTransmitterV2Abi,
    client: { public: destPublicClient, wallet: walletClient },
  });

  const recovery: SolanaMintRecovery = Object.freeze({
    toChain,
    recipient,
    attestedMessage: attested.message,
    attestation: attested.attestation,
    nonce: decoded.nonce,
  });
  const fail = (code: SolanaBridgeErrorCode, message: string, mintTxHash?: Hash): SolanaBridgeError => {
    const e = new SolanaBridgeError(code, message);
    e.mintRecovery = Object.freeze({ ...recovery, ...(mintTxHash ? { mintTxHash } : {}) });
    return e;
  };
  const readUsedNonce = async (): Promise<bigint> => {
    let used: bigint;
    try {
      used = await transmitter.read.usedNonces([decoded.nonce]) as bigint;
    } catch (err) {
      throw fail('MINT_FAILED', `could not read usedNonces(${decoded.nonce}) on ${toChain}: ${err instanceof Error ? err.message : String(err)}. Nothing was submitted; retry later.`, ctx.priorMintTxHash);
    }
    if (typeof used !== 'bigint') {
      throw fail('MINT_FAILED', `usedNonces(${decoded.nonce}) returned an invalid value; nothing was submitted.`, ctx.priorMintTxHash);
    }
    return used;
  };

  // A retained mint is resolved before any new write.
  if (ctx.priorMintTxHash) {
    const prior = ctx.priorMintTxHash;
    let priorReceipt;
    try {
      priorReceipt = await destPublicClient.getTransactionReceipt({ hash: prior });
    } catch (err) {
      throw fail('MINT_UNCONFIRMED', `earlier receiveMessage ${prior} on ${toChain} is not yet confirmed (${err instanceof Error ? err.message : String(err)}); nothing was resubmitted.`, prior);
    }
    if (priorReceipt?.status === 'success') {
      if (await readUsedNonce() === 0n) {
        throw fail('MINT_UNCONFIRMED', `earlier tx ${prior} succeeded but nonce ${decoded.nonce} is not consumed on ${toChain}; reconcile manually, nothing was resubmitted.`, prior);
      }
      return { mintTxHash: prior, amount: mintedAmount, toChain, recipient, elapsedMs: Date.now() - startMs };
    }
    if (priorReceipt?.status !== 'reverted') {
      throw fail('MINT_UNCONFIRMED', `earlier receiveMessage ${prior} on ${toChain} has no definite status; nothing was resubmitted.`, prior);
    }
    // Reverted: fall through to the nonce check before minting again.
  }

  // Reconcile the nonce first: a used nonce means the mint already happened.
  if (await readUsedNonce() !== 0n) {
    throw fail('MINT_ALREADY_RECEIVED', `CCTP nonce ${decoded.nonce} was already received on ${toChain}; do not resubmit.`);
  }
  if (ctx.holdUnreconciled) {
    throw fail('MINT_SUBMISSION_UNKNOWN', `the earlier receiveMessage on ${toChain} has no known hash and may still be pending; nonce ${decoded.nonce} is not yet consumed. Reconcile that submission, then call resumeSolanaToEVM with { originalSubmissionReconciled: true }.`);
  }

  let mintTxHash: Hash;
  try {
    mintTxHash = await transmitter.write.receiveMessage(
      [attested.message, attested.attestation],
      { account, chain: destChain },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isDefinitelyNotBroadcast(err)) {
      throw fail('MINT_FAILED', `CCTP receiveMessage on ${toChain} was not submitted: ${msg}.`);
    }
    throw fail('MINT_SUBMISSION_UNKNOWN', `CCTP receiveMessage on ${toChain} outcome unknown: ${msg}. Check usedNonces(${decoded.nonce}) and recent transactions before retrying.`);
  }

  let mintReceipt;
  try {
    mintReceipt = await destPublicClient.waitForTransactionReceipt({ hash: mintTxHash });
  } catch (err: unknown) {
    throw fail('MINT_UNCONFIRMED', `receiveMessage submitted on ${toChain} (tx: ${mintTxHash}) but its receipt could not be read: ${err instanceof Error ? err.message : String(err)}. Resume with resumeSolanaToEVM(error.mintRecovery); do not resubmit blindly.`, mintTxHash);
  }
  if (mintReceipt.status !== 'success') {
    throw fail('MINT_FAILED', `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`, mintTxHash);
  }

  return { mintTxHash, amount: mintedAmount, toChain, recipient, elapsedMs: Date.now() - startMs };
}

// ─── Shared helpers ───

/**
 * Extract CCTP MessageSent event from EVM transaction logs.
 * Event topic: keccak256("MessageSent(bytes)") = 0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036
 */
function extractMessageSent(
  logs: readonly { address?: string; topics: readonly Hex[]; data: Hex }[],
  messageTransmitter: Address,
): { messageBytes: Hex; messageHash: Hex } {
  const MESSAGE_SENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';
  const emitter = messageTransmitter.toLowerCase();
  for (const log of logs) {
    if (log.address?.toLowerCase() !== emitter) continue;
    if (log.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC.toLowerCase()) {
      const dataHex = log.data.slice(2);
      if (dataHex.length < 128) continue;
      const lengthHex = dataHex.slice(64, 128);
      const messageLength = parseInt(lengthHex, 16);
      if (messageLength === 0) continue;
      const messageBytesHex = dataHex.slice(128, 128 + messageLength * 2);
      const messageBytes = ('0x' + messageBytesHex) as Hex;
      const messageHash = keccak256(messageBytes);
      return { messageBytes, messageHash };
    }
  }
  throw new SolanaBridgeError('BURN_UNCONFIRMED', 'Could not find a MessageSent event from the CCTP MessageTransmitter in the burn receipt.');
}

/** Poll Circle IRIS V2 attestation API by source domain + burn tx hash/signature (#44), bounded. */
async function pollForAttestation(burnTx: string, sourceDomain: number, apiUrl: string, expectedMessage: Hex, select?: AttestationSelector): Promise<CctpAttestedMessage> {
  return pollCircleAttestation({
    burnTx,
    sourceDomain,
    apiUrl,
    expectedMessage,
    select,
    maxPolls: MAX_ATTESTATION_POLLS,
    intervalMs: ATTESTATION_POLL_INTERVAL_MS,
    sleep,
    makeError: (code, message) => new SolanaBridgeError(code, message),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Error Class ───

export type SolanaBridgeErrorCode =
  | 'BURN_SUBMISSION_UNKNOWN'
  | 'NO_WALLET_CLIENT'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECIPIENT'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'BURN_FAILED'
  | 'ATTESTATION_ERROR'
  | 'ATTESTATION_TIMEOUT'
  | 'BURN_UNCONFIRMED'
  | 'MINT_FAILED'
  | 'MINT_SUBMISSION_UNKNOWN'
  | 'MINT_UNCONFIRMED'
  | 'MINT_ALREADY_RECEIVED';

export class SolanaBridgeError extends Error {
  readonly code: SolanaBridgeErrorCode;
  /** EVM→Solana: present once the burn hash is known. Pass to resumeEVMToSolana(). */
  recovery?: SolanaBridgeRecovery;
  /** Solana→EVM: attested message, nonce and (if broadcast) mint hash to reconcile. */
  mintRecovery?: SolanaMintRecovery;
  constructor(code: SolanaBridgeErrorCode, message: string) {
    super(`[SolanaBridge:${code}] ${message}`);
    this.code = code;
    this.name = 'SolanaBridgeError';
  }
}
