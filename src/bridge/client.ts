/**
 * @module bridge/client
 * BridgeModule — CCTP V2 cross-chain USDC bridge for AgentWallet (EVM↔EVM).
 *
 * Implements a full EVM-to-EVM USDC bridge using Circle's CCTP V2 protocol.
 * Non-custodial: all signing is done locally via the agent's viem WalletClient.
 *
 * For EVM↔Solana bridging, see bridge/solana.ts.
 *
 * Supported chains: Ethereum, Avalanche, Optimism, Arbitrum, Base, Polygon,
 *                   Unichain, Linea, Sonic, Worldchain.
 *
 * Flow: approve USDC → depositForBurn → poll Circle IRIS → receiveMessage
 */
// BridgeModule — CCTP V2 cross-chain USDC bridge for AgentWallet
// Non-custodial: all signing is done locally via the agent's WalletClient.
import { attestationUrl, parseAttestationResponse, isDefinitelyNotBroadcast, BURN_SUBMISSION_UNKNOWN_HINT, type CctpAttestedMessage, type CircleV2MessagesResponse } from './attestation.js';
import {
  createPublicClient,
  http,
  keccak256,
  pad,
  getContract,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
} from 'viem';
import { base, mainnet, optimism, arbitrum, polygon, avalanche, linea } from 'viem/chains';
import {
  TokenMessengerV2Abi,
  MessageTransmitterV2Abi,
  ERC20BridgeAbi,
} from './abis.js';
import type { BridgeChain, EVMBridgeChain, BridgeOptions, BurnResult, BridgeResult } from './types.js';
import {
  CCTP_DOMAIN_IDS,
  BRIDGE_CHAIN_IDS,
  USDC_CONTRACT,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  FINALITY_THRESHOLD,
  CIRCLE_ATTESTATION_API,
  MAX_ATTESTATION_POLLS,
  ATTESTATION_POLL_INTERVAL_MS,
} from './types.js';

/**
 * Viem chain definitions for all supported EVM CCTP V2 chains.
 * Chains without built-in viem definitions use custom definitions.
 * Solana is NOT included — use bridge/solana.ts for EVM↔Solana bridging.
 */
const VIEM_CHAINS: Record<EVMBridgeChain, any> = {
  base,
  ethereum: mainnet,
  optimism,
  arbitrum,
  polygon,
  avalanche,
  linea,
  unichain:   { id: 130, name: 'Unichain',    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } } },
  sonic:      { id: 146, name: 'Sonic',        nativeCurrency: { name: 'S',   symbol: 'S',   decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.soniclabs.com'] } } },
  worldchain: { id: 480, name: 'World Chain',  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://worldchain-mainnet.g.alchemy.com/public'] } } },
};

export class BridgeModule {
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;
  private readonly fromChain: EVMBridgeChain;
  private readonly fromRpcUrl: string | undefined;

  constructor(
    walletClient: WalletClient,
    fromChain: EVMBridgeChain = 'base',
    options: { rpcUrl?: string } = {},
  ) {
    if (!walletClient.account) {
      throw new BridgeError(
        'NO_WALLET_CLIENT',
        'WalletClient must have an account attached. Use privateKeyToAccount() or similar to attach a signer.',
      );
    }
    this.walletClient = walletClient;
    this.fromChain = fromChain;
    this.fromRpcUrl = options.rpcUrl;
    this.publicClient = createPublicClient({
      chain: VIEM_CHAINS[fromChain],
      transport: http(options.rpcUrl),
    }) as PublicClient;
  }

  async bridge(amount: bigint, toChain: EVMBridgeChain, options: BridgeOptions = {}): Promise<BridgeResult> {
    const startMs = Date.now();
    this.validateBridgeParams(amount, toChain);
    const account = this.walletClient.account!;
    const recipient = options.destinationAddress ?? account.address;
    const minFinalityThreshold = options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
    const maxFee = options.maxFee ?? 0n;
    const attestationApiUrl = options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

    await this.approveUsdc(amount);
    const burnResult = await this.depositForBurn(amount, toChain, recipient, minFinalityThreshold, maxFee);
    let mintTxHash: Hash;
    let attested: CctpAttestedMessage | undefined;
    try {
      attested = await this.pollForAttestation(burnResult.burnTxHash, this.fromChain, attestationApiUrl, burnResult.messageBytes);
      mintTxHash = await this.receiveMessage(attested.message, attested.attestation, toChain, options.destinationRpcUrl);
    } catch (err: unknown) {
      // USDC is already burned: never drop the data needed to finish the mint.
      const recovery: BridgeRecovery = {
        burnTxHash: burnResult.burnTxHash,
        sourceDomain: burnResult.sourceDomain,
        destinationDomain: burnResult.destinationDomain,
        messageHash: burnResult.messageHash,
        messageBytes: burnResult.messageBytes,
        nonce: burnResult.nonce,
        toChain,
        ...(attested ? {
          attestedMessage: attested.message,
          attestation: attested.attestation,
          eventNonce: attested.eventNonce,
        } : {}),
      };
      if (err instanceof BridgeError) {
        if (err.mintTxHash) recovery.mintTxHash = err.mintTxHash;
        err.recovery = recovery; throw err;
      }
      const e = new BridgeError('MINT_FAILED', err instanceof Error ? err.message : String(err));
      e.recovery = recovery;
      throw e;
    }

    return {
      burnTxHash: burnResult.burnTxHash,
      mintTxHash,
      amount,
      fromChain: this.fromChain,
      toChain,
      recipient,
      nonce: burnResult.nonce,
      eventNonce: attested!.eventNonce,
      elapsedMs: Date.now() - startMs,
    };
  }

  async burn(amount: bigint, toChain: EVMBridgeChain, options: BridgeOptions = {}): Promise<BurnResult> {
    this.validateBridgeParams(amount, toChain);
    const account = this.walletClient.account!;
    const recipient = options.destinationAddress ?? account.address;
    const minFinalityThreshold = options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
    const maxFee = options.maxFee ?? 0n;
    await this.approveUsdc(amount);
    return this.depositForBurn(amount, toChain, recipient, minFinalityThreshold, maxFee);
  }

  /**
   * Wait for Circle's CCTP V2 attestation for a burn.
   * @param burnTxHash - the depositForBurn transaction hash (BurnResult.burnTxHash).
   *   (Before 6.3.2 this took a message hash, which Circle V2 cannot look up — see #44.)
   * @returns the attested message and attestation; pass both to mint().
   */
  async waitForAttestation(burnTxHash: Hash, apiUrl: string = CIRCLE_ATTESTATION_API): Promise<CctpAttestedMessage> {
    return this.pollForAttestation(burnTxHash, this.fromChain, apiUrl);
  }

  async mint(messageBytes: Hex, attestation: Hex, toChain: EVMBridgeChain, destinationRpcUrl?: string): Promise<Hash> {
    return this.receiveMessage(messageBytes, attestation, toChain, destinationRpcUrl);
  }

  async getUsdcBalance(): Promise<bigint> {
    const account = this.walletClient.account!;
    const usdc = getContract({
      address: USDC_CONTRACT[this.fromChain],
      abi: ERC20BridgeAbi,
      client: this.publicClient,
    });
    return usdc.read.balanceOf([account.address]) as Promise<bigint>;
  }

  async getUsdcAllowance(): Promise<bigint> {
    const account = this.walletClient.account!;
    const usdc = getContract({
      address: USDC_CONTRACT[this.fromChain],
      abi: ERC20BridgeAbi,
      client: this.publicClient,
    });
    return usdc.read.allowance([account.address, TOKEN_MESSENGER_V2[this.fromChain]]) as Promise<bigint>;
  }

  private async approveUsdc(amount: bigint): Promise<void> {
    const account = this.walletClient.account!;
    const spender = TOKEN_MESSENGER_V2[this.fromChain];
    const usdcAddress = USDC_CONTRACT[this.fromChain];
    const usdc = getContract({ address: usdcAddress, abi: ERC20BridgeAbi, client: this.publicClient });
    const currentAllowance = await usdc.read.allowance([account.address, spender]) as bigint;
    if (currentAllowance >= amount) return;

    const usdcWrite = getContract({
      address: usdcAddress,
      abi: ERC20BridgeAbi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });
    const approveTxHash = await usdcWrite.write.approve([spender, amount], {
      account,
      chain: VIEM_CHAINS[this.fromChain],
    });
    const approveReceipt = await this.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status !== 'success') {
      throw new BridgeError('INSUFFICIENT_ALLOWANCE', `USDC approve failed (tx: ${approveTxHash}).`);
    }
  }

  private async depositForBurn(
    amount: bigint,
    toChain: EVMBridgeChain,
    recipient: `0x${string}`,
    minFinalityThreshold: number,
    maxFee: bigint,
  ): Promise<BurnResult> {
    const account = this.walletClient.account!;
    const destinationDomain = CCTP_DOMAIN_IDS[toChain];
    const messengerAddress = TOKEN_MESSENGER_V2[this.fromChain];
    const usdcAddress = USDC_CONTRACT[this.fromChain];
    const mintRecipient = pad(recipient, { size: 32 });
    const destinationCaller = pad('0x0' as Hex, { size: 32 });

    const messenger = getContract({
      address: messengerAddress,
      abi: TokenMessengerV2Abi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });

    let burnTxHash: Hash;
    try {
      burnTxHash = await messenger.write.depositForBurn(
        [amount, destinationDomain, mintRecipient, usdcAddress, destinationCaller, maxFee, minFinalityThreshold],
        { account, chain: VIEM_CHAINS[this.fromChain] },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDefinitelyNotBroadcast(err)) {
        throw new BridgeError('BURN_FAILED', `CCTP depositForBurn failed: ${msg}.`);
      }
      throw new BridgeError('BURN_SUBMISSION_UNKNOWN', `CCTP depositForBurn outcome unknown: ${msg}. ${BURN_SUBMISSION_UNKNOWN_HINT}`);
    }

    let receipt: TransactionReceipt;
    let extracted: { messageBytes: Hex; messageHash: Hex; nonce: bigint };
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: burnTxHash });
      if (receipt.status !== 'success') {
        throw new BridgeError('BURN_FAILED', `depositForBurn transaction reverted (tx: ${burnTxHash}).`);
      }
      extracted = this.extractMessageSent(receipt);
    } catch (err: unknown) {
      if (err instanceof BridgeError && err.code === 'BURN_FAILED') throw err;
      // Burn was submitted: it may have burned USDC. Keep the tx hash so the
      // caller can finish via waitForAttestation(burnTxHash) + mint().
      const e = err instanceof BridgeError ? err
        : new BridgeError('BURN_UNCONFIRMED', `Burn submitted (tx: ${burnTxHash}) but receipt handling failed: ${err instanceof Error ? err.message : String(err)}. Funds may be burned: call waitForAttestation(burnTxHash) then mint().`);
      e.recovery = { burnTxHash, sourceDomain: CCTP_DOMAIN_IDS[this.fromChain], destinationDomain, toChain };
      throw e;
    }
    const { messageBytes, messageHash, nonce } = extracted;
    return { burnTxHash, nonce, messageHash, messageBytes, sourceDomain: CCTP_DOMAIN_IDS[this.fromChain], destinationDomain };
  }

  private extractMessageSent(receipt: TransactionReceipt): { messageBytes: Hex; messageHash: Hex; nonce: bigint } {
    const MESSAGE_SENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC.toLowerCase()) {
        const rawData = log.data;
        if (rawData.length < 130) continue;
        const dataHex = rawData.slice(2);
        const lengthHex = dataHex.slice(64, 128);
        const messageLength = parseInt(lengthHex, 16);
        if (messageLength === 0) continue;
        const messageBytesHex = dataHex.slice(128, 128 + messageLength * 2);
        const messageBytes = ('0x' + messageBytesHex) as Hex;
        const messageHash = keccak256(messageBytes);
        const nonceBytesHex = messageBytesHex.slice(24, 40);
        const nonce = BigInt('0x' + nonceBytesHex);
        return { messageBytes, messageHash, nonce };
      }
    }
    throw new BridgeError('BURN_FAILED', 'Could not find MessageSent event in burn transaction receipt.');
  }

  private async pollForAttestation(burnTxHash: Hash, fromChain: EVMBridgeChain, apiUrl: string, expectedMessage?: Hex): Promise<CctpAttestedMessage> {
    const sourceDomain = CCTP_DOMAIN_IDS[fromChain];
    const url = attestationUrl(apiUrl, sourceDomain, burnTxHash);
    const fail = (m: string): never => { throw new BridgeError('ATTESTATION_ERROR', `Circle attestation failed: ${m}.`); };

    for (let attempt = 0; attempt < MAX_ATTESTATION_POLLS; attempt++) {
      let body: CircleV2MessagesResponse;
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          if (res.status === 404) { await this.sleep(ATTESTATION_POLL_INTERVAL_MS); continue; }
          const text = await res.text().catch(() => '');
          throw new BridgeError('ATTESTATION_ERROR', `Circle API returned HTTP ${res.status}: ${text}.`);
        }
        body = await res.json() as CircleV2MessagesResponse;
      } catch (err: unknown) {
        if (err instanceof BridgeError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new BridgeError('ATTESTATION_ERROR', `Failed to reach Circle IRIS API: ${msg}.`);
      }
      const r = parseAttestationResponse(body, fail, expectedMessage);
      if (r !== 'pending') return r;
      await this.sleep(ATTESTATION_POLL_INTERVAL_MS);
    }
    throw new BridgeError('ATTESTATION_TIMEOUT',
      `Attestation not received after ${MAX_ATTESTATION_POLLS} attempts. Burn tx: ${burnTxHash} (source domain ${sourceDomain}). Funds are not lost: call waitForAttestation(burnTxHash) then mint() to recover.`);
  }

  private async receiveMessage(messageBytes: Hex, attestation: Hex, toChain: EVMBridgeChain, destinationRpcUrl?: string): Promise<Hash> {
    const account = this.walletClient.account!;
    const transmitterAddress = MESSAGE_TRANSMITTER_V2[toChain];
    const destChain = VIEM_CHAINS[toChain];
    const destPublicClient = createPublicClient({ chain: destChain, transport: http(destinationRpcUrl) }) as PublicClient;

    const transmitter = getContract({
      address: transmitterAddress,
      abi: MessageTransmitterV2Abi,
      client: { public: destPublicClient, wallet: this.walletClient },
    });

    let mintTxHash: Hash;
    try {
      mintTxHash = await transmitter.write.receiveMessage([messageBytes, attestation], { account, chain: destChain });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError('MINT_FAILED', `CCTP receiveMessage failed on ${toChain}: ${msg}.`);
    }

    let mintReceipt;
    try {
      mintReceipt = await destPublicClient.waitForTransactionReceipt({ hash: mintTxHash });
    } catch (err: unknown) {
      const e = new BridgeError('MINT_UNCONFIRMED', `receiveMessage submitted on ${toChain} (tx: ${mintTxHash}) but receipt polling failed: ${err instanceof Error ? err.message : String(err)}. Check this tx before retrying.`);
      e.mintTxHash = mintTxHash;
      throw e;
    }
    if (mintReceipt.status !== 'success') {
      const e = new BridgeError('MINT_FAILED', `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`);
      e.mintTxHash = mintTxHash;
      throw e;
    }
    return mintTxHash;
  }

  private validateBridgeParams(amount: bigint, toChain: EVMBridgeChain): void {
    if (amount <= 0n) {
      throw new BridgeError('INVALID_AMOUNT', `Bridge amount must be greater than 0. Received: ${amount}.`);
    }
    if (!(toChain in CCTP_DOMAIN_IDS)) {
      throw new BridgeError('UNSUPPORTED_CHAIN', `Chain '${toChain}' is not supported.`);
    }
    if (toChain === this.fromChain) {
      throw new BridgeError('UNSUPPORTED_CHAIN', `Source and destination chains must be different.`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export interface BridgeRecovery {
  burnTxHash: Hash;
  sourceDomain: number;
  destinationDomain: number;
  /** Absent if the burn receipt could not be read (code BURN_UNCONFIRMED). */
  messageHash?: Hex;
  messageBytes?: Hex;
  /** Source MessageSent nonce (zero in CCTP V2; see eventNonce). */
  nonce?: bigint;
  toChain: EVMBridgeChain;
  /** Present when attestation succeeded: pass these to mint() to finish. */
  attestedMessage?: Hex;
  attestation?: Hex;
  /** Circle-assigned V2 event nonce. */
  eventNonce?: Hex;
  /** Set when receiveMessage was already broadcast: monitor it, do not resend blindly. */
  mintTxHash?: Hash;
}

export class BridgeError extends Error {
  readonly code: string;
  /** Set when USDC was already burned; use it to finish the mint later. */
  recovery?: BridgeRecovery;
  /** Destination receiveMessage tx, when it was broadcast. */
  mintTxHash?: Hash;
  constructor(code: string, message: string) {
    super(`[BridgeModule:${code}] ${message}`);
    this.code = code;
    this.name = 'BridgeError';
  }
}

export function createBridge(
  walletClient: WalletClient,
  fromChain: EVMBridgeChain = 'base',
  options: { rpcUrl?: string } = {},
): BridgeModule {
  return new BridgeModule(walletClient, fromChain, options);
}

export type { CctpAttestedMessage } from './attestation.js';
export type { BridgeChain, EVMBridgeChain, BridgeOptions, BurnResult, BridgeResult };
export {
  CCTP_DOMAIN_IDS, BRIDGE_CHAIN_IDS, USDC_CONTRACT,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, FINALITY_THRESHOLD,
};
