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
import {
  createPublicClient,
  http,
  pad,
  getContract,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base, mainnet, optimism, arbitrum, polygon, avalanche, linea } from 'viem/chains';
import {
  TokenMessengerV2Abi,
  MessageTransmitterV2Abi,
  ERC20BridgeAbi,
} from './abis.js';
import type { AttestedMessage, BridgeRecovery, BridgeChain, EVMBridgeChain, BridgeOptions, BurnResult, BridgeResult } from './types.js';
import { BridgeError, withBridgeRecovery } from './errors.js';
import { assertAttestedMessage, assertMessageFields, evmMintRecipient, extractBurnResult, parseCctpMessage, pollForAttestation, type CctpMessage } from './messages.js';
import {
  CCTP_DOMAIN_IDS,
  BRIDGE_CHAIN_IDS,
  USDC_CONTRACT,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  FINALITY_THRESHOLD,
  CIRCLE_ATTESTATION_API,
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
    const burnResult = await this.burn(amount, toChain, options);
    return this.completeBurn(burnResult, toChain, options, startMs);
  }

  /** Resume a known source burn. This method never approves USDC or calls depositForBurn. */
  async resume(burnTxHash: Hash, toChain: EVMBridgeChain, options: BridgeOptions = {}): Promise<BridgeResult> {
    const startMs = Date.now();
    const burnResult = await this.confirmBurn(burnTxHash, {
      ...this.sourceMessageFields(), destinationDomain: CCTP_DOMAIN_IDS[toChain],
      recipient: pad(TOKEN_MESSENGER_V2[toChain], { size: 32 }),
      ...(options.destinationAddress ? { mintRecipient: pad(options.destinationAddress, { size: 32 }) } : {}),
      ...(options.minFinalityThreshold !== undefined ? { minFinalityThreshold: options.minFinalityThreshold } : {}),
      ...(options.maxFee !== undefined ? { maxFee: options.maxFee } : {}),
    });
    return this.completeBurn(burnResult, toChain, options, startMs);
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

  /** Lookup by burn transaction hash; returns the signed message together with its signature. */
  async waitForAttestation(burnTxHash: Hash, apiUrl: string = CIRCLE_ATTESTATION_API): Promise<AttestedMessage> {
    const burnResult = await this.confirmBurn(burnTxHash, this.sourceMessageFields());
    try {
      return await pollForAttestation(burnTxHash, burnResult.messageBytes, apiUrl);
    } catch (error) {
      throw withBridgeRecovery(error, burnResult, 'ATTESTATION_ERROR');
    }
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
      throw new BridgeError('BURN_FAILED', `CCTP depositForBurn failed: ${msg}.`);
    }

    return this.confirmBurn(burnTxHash, {
      ...this.sourceMessageFields(), destinationDomain, mintRecipient, destinationCaller,
      recipient: pad(TOKEN_MESSENGER_V2[toChain], { size: 32 }), amount, minFinalityThreshold, maxFee,
    });
  }

  private sourceMessageFields(): Partial<CctpMessage> {
    return {
      sourceDomain: CCTP_DOMAIN_IDS[this.fromChain],
      sender: pad(TOKEN_MESSENGER_V2[this.fromChain], { size: 32 }),
      burnToken: pad(USDC_CONTRACT[this.fromChain], { size: 32 }),
      messageSender: pad(this.walletClient.account!.address, { size: 32 }),
    };
  }

  private async confirmBurn(burnTxHash: Hash, expected: Partial<CctpMessage>): Promise<BurnResult> {
    const recovery: BridgeRecovery = { burnTxHash, sourceDomain: CCTP_DOMAIN_IDS[this.fromChain], destinationDomain: expected.destinationDomain };
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: burnTxHash });
      return extractBurnResult(receipt, burnTxHash, MESSAGE_TRANSMITTER_V2[this.fromChain], expected);
    } catch (error) {
      throw withBridgeRecovery(error, recovery, 'BURN_FAILED');
    }
  }

  private async completeBurn(burnResult: BurnResult, toChain: EVMBridgeChain, options: BridgeOptions, startMs: number): Promise<BridgeResult> {
    try {
      const source = parseCctpMessage(burnResult.messageBytes);
      assertMessageFields(source, { destinationDomain: CCTP_DOMAIN_IDS[toChain] });
      const attested = await pollForAttestation(burnResult.burnTxHash, burnResult.messageBytes, options.attestationApiUrl ?? CIRCLE_ATTESTATION_API);
      const mintTxHash = await this.receiveMessage(
        attested.message, attested.attestation, toChain, options.destinationRpcUrl, burnResult, options.mintTxHash,
      );
      return {
        burnTxHash: burnResult.burnTxHash, mintTxHash, amount: source.amount, fromChain: this.fromChain, toChain,
        recipient: evmMintRecipient(parseCctpMessage(attested.message)), nonce: attested.nonce, elapsedMs: Date.now() - startMs,
      };
    } catch (error) {
      throw withBridgeRecovery(error, burnResult, 'MINT_FAILED');
    }
  }

  private async receiveMessage(
    messageBytes: Hex,
    attestation: Hex,
    toChain: EVMBridgeChain,
    destinationRpcUrl?: string,
    recovery?: BridgeRecovery,
    existingMintTxHash?: Hash,
  ): Promise<Hash> {
    const message = parseCctpMessage(messageBytes);
    assertMessageFields(message, { destinationDomain: CCTP_DOMAIN_IDS[toChain], recipient: pad(TOKEN_MESSENGER_V2[toChain], { size: 32 }) }, 'MINT_FAILED');
    assertAttestedMessage(message, attestation, 'MINT_FAILED');
    evmMintRecipient(message);
    const account = this.walletClient.account!;
    const transmitterAddress = MESSAGE_TRANSMITTER_V2[toChain];
    const destChain = VIEM_CHAINS[toChain];
    const destPublicClient = createPublicClient({ chain: destChain, transport: http(destinationRpcUrl) }) as PublicClient;

    if (existingMintTxHash) {
      try {
        const existingReceipt = await destPublicClient.waitForTransactionReceipt({ hash: existingMintTxHash });
        if (existingReceipt.status === 'success') return existingMintTxHash;
      } catch (error) {
        if (recovery) throw withBridgeRecovery(error, { ...recovery, mintTxHash: existingMintTxHash }, 'MINT_FAILED');
        throw new BridgeError('MINT_FAILED', `Could not confirm mint transaction ${existingMintTxHash}: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }

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

    try {
      const mintReceipt = await destPublicClient.waitForTransactionReceipt({ hash: mintTxHash });
      if (mintReceipt.status !== 'success') {
        throw new BridgeError('MINT_FAILED', `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`);
      }
    } catch (error) {
      if (recovery) throw withBridgeRecovery(error, { ...recovery, mintTxHash }, 'MINT_FAILED');
      throw new BridgeError('MINT_FAILED', `Could not confirm mint transaction ${mintTxHash}: ${error instanceof Error ? error.message : String(error)}.`);
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

}

export { BridgeError } from './errors.js';

export function createBridge(
  walletClient: WalletClient,
  fromChain: EVMBridgeChain = 'base',
  options: { rpcUrl?: string } = {},
): BridgeModule {
  return new BridgeModule(walletClient, fromChain, options);
}

export type { BridgeChain, EVMBridgeChain, BridgeOptions, BurnResult, BridgeResult };
export {
  CCTP_DOMAIN_IDS, BRIDGE_CHAIN_IDS, USDC_CONTRACT,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, FINALITY_THRESHOLD,
};
