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
  FINALITY_THRESHOLD,
  type BridgeRecovery,
  type EVMBridgeChain,
} from './types.js';
import { BridgeError } from './errors.js';
import { assertMessageFields, evmMintRecipient, extractBurnResult, parseCctpMessage, pollForAttestation } from './messages.js';

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
function solanaPubkeyToBytes32(base58Address: string): Hex {
  // Dynamic import for optional @solana/web3.js
  // We manually decode base58 here to avoid requiring the dependency at import time.
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (base58Address.length < 32 || base58Address.length > 44) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', 'Expected a canonical 32-byte Solana public key.');
  }
  const bytes = new Uint8Array(32);
  let intVal = 0n;
  for (const char of base58Address) {
    const digit = BigInt(ALPHABET.indexOf(char));
    if (digit < 0n) throw new SolanaBridgeError('INVALID_RECIPIENT', `Invalid base58 character '${char}' in address.`);
    intVal = intVal * 58n + digit;
  }
  // Write to 32-byte big-endian buffer
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(intVal & 0xffn);
    intVal >>= 8n;
  }
  if (intVal !== 0n) throw new SolanaBridgeError('INVALID_RECIPIENT', 'Address value overflows 32 bytes.');
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  if (bytes32ToSolanaPubkey(`0x${hex}`) !== base58Address) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', 'Expected a canonical 32-byte Solana public key.');
  }
  return `0x${hex}` as Hex;
}

/**
 * Decode a 32-byte hex buffer back to a Solana base58 public key.
 * Used when interpreting Solana→EVM message recipient fields.
 */
export function bytes32ToSolanaPubkey(bytes32: Hex): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const hex = bytes32.startsWith('0x') ? bytes32.slice(2) : bytes32;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('SolanaBridge: Expected a 32-byte hex value.');
  let intVal = BigInt('0x' + hex);
  let result = '';
  while (intVal > 0n) {
    const rem = Number(intVal % 58n);
    intVal /= 58n;
    result = ALPHABET[rem] + result;
  }
  const leadingZeroBytes = (hex.match(/^(?:00)*/)?.[0].length ?? 0) / 2;
  return '1'.repeat(leadingZeroBytes) + result;
}

// ─── EVM→Solana Bridge ───

export interface EVMToSolanaOptions {
  /** Existing Solana USDC token account (base58), not its wallet owner. */
  solanaRecipient: string;
  /** Solana RPC endpoint used to verify the USDC token account before burning. */
  solanaRpcUrl?: string;
  /** Resume this existing EVM burn transaction instead of approving or burning again. */
  burnTxHash?: Hash;
  /** EVM source chain. Defaults to 'base'. */
  fromChain?: EVMBridgeChain;
  /** Optional EVM RPC URL override. */
  evmRpcUrl?: string;
  /** Finality threshold: FAST (1000) or FINALIZED (2000). Default: FAST. */
  minFinalityThreshold?: number;
  /** Max bridge fee in USDC base units. Default: 0 (no fee). */
  maxFee?: bigint;
  /** Circle IRIS API URL override. */
  attestationApiUrl?: string;
}

export interface EVMToSolanaResult {
  /** EVM burn transaction hash */
  burnTxHash: Hash;
  /** Hash of the returned attested message. Polling uses burnTxHash. */
  messageHash: Hex;
  /** Attested CCTP V2 message bytes (for manual receiveMessage on Solana) */
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
  if (amount <= 0n) {
    throw new SolanaBridgeError('INVALID_AMOUNT', `Bridge amount must be > 0. Received: ${amount}.`);
  }
  if (!options.solanaRecipient) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', 'solanaRecipient (base58 Solana address) is required.');
  }

  // Circle requires an existing USDC token account, rather than its wallet owner.
  let mintRecipient: Hex;
  try {
    mintRecipient = solanaPubkeyToBytes32(options.solanaRecipient);
    await validateSolanaTokenAccount(options.solanaRecipient, options.solanaRpcUrl ?? SOLANA_DEFAULT_RPC);
  } catch (error) {
    if (options.burnTxHash) throw withSolanaRecovery(error, { burnTxHash: options.burnTxHash, sourceDomain: CCTP_DOMAIN_IDS[fromChain], destinationDomain: SOLANA_CCTP_DOMAIN });
    throw error;
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

  let burnTxHash = options.burnTxHash;
  if (!burnTxHash) {
    const usdcRead = getContract({ address: usdcAddress, abi: ERC20BridgeAbi, client: publicClient });
    const currentAllowance = await usdcRead.read.allowance([account.address, messengerAddress]) as bigint;
    if (currentAllowance < amount) {
      const usdcWrite = getContract({ address: usdcAddress, abi: ERC20BridgeAbi, client: { public: publicClient, wallet: walletClient } });
      const approveTxHash = await usdcWrite.write.approve([messengerAddress, amount], { account, chain: VIEM_CHAINS[fromChain] });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      if (approveReceipt.status !== 'success') {
        throw new SolanaBridgeError('INSUFFICIENT_ALLOWANCE', `USDC approve failed (tx: ${approveTxHash}).`);
      }
    }
    const messenger = getContract({ address: messengerAddress, abi: TokenMessengerV2Abi, client: { public: publicClient, wallet: walletClient } });
    try {
      burnTxHash = await messenger.write.depositForBurn(
        [amount, SOLANA_CCTP_DOMAIN, mintRecipient, usdcAddress, destinationCaller, maxFee, minFinalityThreshold],
        { account, chain: VIEM_CHAINS[fromChain] },
      );
    } catch (err: unknown) {
      throw new SolanaBridgeError('BURN_FAILED', `CCTP depositForBurn to Solana failed: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  let recovery: BridgeRecovery = { burnTxHash, sourceDomain: CCTP_DOMAIN_IDS[fromChain], destinationDomain: SOLANA_CCTP_DOMAIN };
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: burnTxHash });
    const burnResult = extractBurnResult(receipt, burnTxHash, MESSAGE_TRANSMITTER_V2_MAP[fromChain], {
      sourceDomain: CCTP_DOMAIN_IDS[fromChain], destinationDomain: SOLANA_CCTP_DOMAIN,
      sender: pad(messengerAddress, { size: 32 }), recipient: solanaPubkeyToBytes32(SOLANA_TOKEN_MESSENGER),
      burnToken: pad(usdcAddress, { size: 32 }), mintRecipient, amount,
      messageSender: pad(account.address, { size: 32 }), destinationCaller,
      ...(!options.burnTxHash || options.minFinalityThreshold !== undefined ? { minFinalityThreshold } : {}),
      ...(!options.burnTxHash || options.maxFee !== undefined ? { maxFee } : {}),
    });
    recovery = burnResult;
    const attested = await pollForAttestation(burnTxHash, burnResult.messageBytes, attestationApiUrl);
    return {
      burnTxHash, messageHash: attested.messageHash, messageBytes: attested.message, attestation: attested.attestation,
      destinationDomain: SOLANA_CCTP_DOMAIN, amount, elapsedMs: Date.now() - startMs,
    };
  } catch (error) {
    throw withSolanaRecovery(error, recovery, 'BURN_FAILED');
  }
}

// ─── Solana→EVM Bridge ───

export interface SolanaToEVMOptions {
  /** EVM destination chain */
  toChain: EVMBridgeChain;
  /** Optional EVM destination RPC URL override */
  evmRpcUrl?: string;
  /** Optional expected EVM mint recipient. Must match the burned and attested recipient. */
  evmRecipient?: Address;
  /** Circle IRIS API URL override */
  attestationApiUrl?: string;
  /** Solana RPC URL override */
  solanaRpcUrl?: string;
  /** Existing destination mint, if a prior receiveMessage hash was retained. */
  mintTxHash?: Hash;
}

export interface SolanaToEVMBurnParams {
  /** Solana burn transaction signature, used to query the V2 attestation API. */
  burnTxHash: string;
  /** Raw CCTP message bytes from Solana burn transaction */
  messageBytes: Hex;
  /** Circle message hash */
  messageHash: Hex;
  /** Source domain (should be SOLANA_CCTP_DOMAIN = 5) */
  sourceDomain: number;
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
 * CCTP MessageTransmitter and passing its transaction signature and source message here.
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

  if (!burnParams.burnTxHash || typeof burnParams.burnTxHash !== 'string') {
    throw new SolanaBridgeError('BURN_FAILED', 'A Solana burn transaction signature is required; message hashes cannot identify V2 attestations.');
  }
  let recovery: BridgeRecovery = {
    burnTxHash: burnParams.burnTxHash, sourceDomain: SOLANA_CCTP_DOMAIN, destinationDomain: CCTP_DOMAIN_IDS[toChain],
    messageBytes: burnParams.messageBytes, messageHash: burnParams.messageHash,
  };
  try {
    const source = parseCctpMessage(burnParams.messageBytes);
    assertMessageFields(source, {
      sourceDomain: SOLANA_CCTP_DOMAIN, destinationDomain: CCTP_DOMAIN_IDS[toChain],
      sender: solanaPubkeyToBytes32(SOLANA_TOKEN_MESSENGER), recipient: pad(TOKEN_MESSENGER_V2[toChain], { size: 32 }),
      burnToken: solanaPubkeyToBytes32(SOLANA_USDC_MINT),
    });
    if (burnParams.sourceDomain !== SOLANA_CCTP_DOMAIN || keccak256(burnParams.messageBytes).toLowerCase() !== burnParams.messageHash.toLowerCase()) {
      throw new SolanaBridgeError('BURN_FAILED', 'Solana source domain or source message hash does not match the supplied burn.');
    }
    const recipient = evmMintRecipient(source);
    if (options.evmRecipient && recipient.toLowerCase() !== options.evmRecipient.toLowerCase()) {
      throw new SolanaBridgeError('INVALID_RECIPIENT', 'evmRecipient does not match the Solana burn mintRecipient.');
    }
    const attested = await pollForAttestation(burnParams.burnTxHash, burnParams.messageBytes, attestationApiUrl);
    const decoded = parseCctpMessage(attested.message);
    const account = walletClient.account;
    const destChain = VIEM_CHAINS[toChain];
    const destPublicClient = createPublicClient({ chain: destChain, transport: http(evmRpcUrl) }) as PublicClient;
    if (options.mintTxHash) {
      recovery = { ...recovery, mintTxHash: options.mintTxHash };
      const existingReceipt = await destPublicClient.waitForTransactionReceipt({ hash: options.mintTxHash });
      if (existingReceipt.status === 'success') {
        return {
          mintTxHash: options.mintTxHash, amount: decoded.amount - decoded.feeExecuted, toChain,
          recipient: evmMintRecipient(decoded), elapsedMs: Date.now() - startMs,
        };
      }
    }
    const transmitter = getContract({ address: MESSAGE_TRANSMITTER_V2_MAP[toChain], abi: MessageTransmitterV2Abi, client: { public: destPublicClient, wallet: walletClient } });
    const mintTxHash = await transmitter.write.receiveMessage([attested.message, attested.attestation], { account, chain: destChain });
    recovery = { ...recovery, mintTxHash };
    const mintReceipt = await destPublicClient.waitForTransactionReceipt({ hash: mintTxHash });
    if (mintReceipt.status !== 'success') {
      throw new SolanaBridgeError('MINT_FAILED', `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`);
    }
    return { mintTxHash, amount: decoded.amount - decoded.feeExecuted, toChain, recipient: evmMintRecipient(decoded), elapsedMs: Date.now() - startMs };
  } catch (error) {
    throw withSolanaRecovery(error, recovery);
  }
}

// ─── Shared helpers ───

async function validateSolanaTokenAccount(address: string, rpcUrl: string): Promise<void> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
    });
    if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
    const data = await response.json() as {
      error?: unknown;
      result?: { value?: { owner?: string; data?: { program?: string; parsed?: { type?: string; info?: { mint?: string; state?: string } } } } | null };
    };
    const account = data.result?.value;
    if (data.error || !account || account.owner !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
        account.data?.program !== 'spl-token' || account.data.parsed?.type !== 'account' ||
        account.data.parsed.info?.mint !== SOLANA_USDC_MINT || account.data.parsed.info.state !== 'initialized') {
      throw new Error('solanaRecipient must be an existing initialized USDC token account');
    }
  } catch (error) {
    throw new SolanaBridgeError('INVALID_RECIPIENT', `Could not verify the Solana USDC recipient: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function withSolanaRecovery(error: unknown, recovery: BridgeRecovery, fallbackCode: SolanaBridgeErrorCode = 'MINT_FAILED'): SolanaBridgeError {
  const code = error instanceof BridgeError || error instanceof SolanaBridgeError ? error.code as SolanaBridgeErrorCode : fallbackCode;
  const detail = error instanceof Error ? error.message.replace(/^\[(?:BridgeModule|SolanaBridge):[^\]]+\] /, '') : String(error);
  return new SolanaBridgeError(code, `${detail} Resume the existing burn transaction ${recovery.burnTxHash}; do not burn again.`, recovery);
}

// ─── Error Class ───

export type SolanaBridgeErrorCode =
  | 'NO_WALLET_CLIENT'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECIPIENT'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'BURN_FAILED'
  | 'ATTESTATION_ERROR'
  | 'ATTESTATION_TIMEOUT'
  | 'MINT_FAILED';

export class SolanaBridgeError extends Error {
  readonly code: SolanaBridgeErrorCode;
  readonly recovery?: BridgeRecovery;
  constructor(code: SolanaBridgeErrorCode, message: string, recovery?: BridgeRecovery) {
    super(`[SolanaBridge:${code}] ${message}`);
    this.code = code;
    this.recovery = recovery;
    this.name = 'SolanaBridgeError';
  }
}
