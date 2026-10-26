/**
 * @module bridge
 * Re-exports for the bridge module: EVM↔EVM CCTP V2 bridge and EVM↔Solana bridge.
 *
 * Import from 'agentwallet-sdk/bridge' or 'agentwallet-sdk' (re-exported from root).
 *
 * EVM↔EVM: use BridgeModule or createBridge()
 * EVM↔Solana: use bridgeEVMToSolana() and receiveFromSolanaOnEVM()
 */
export {
  BridgeModule, BridgeError, createBridge,
  CCTP_DOMAIN_IDS, BRIDGE_CHAIN_IDS, USDC_CONTRACT,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, FINALITY_THRESHOLD,
} from './client.js';
export type { BridgeRecovery } from './client.js';
export type { CctpAttestedMessage, AttestationSelector, DecodedCctpV2Message, ExpectedBurnTerms } from './attestation.js';
export { decodeCctpV2Message, assertBurnTerms } from './attestation.js';
export type {
  BridgeChain, EVMBridgeChain, BridgeOptions, BurnResult, BridgeResult, AttestationResponse, AttestationStatus,
} from './types.js';
export { TokenMessengerV2Abi, MessageTransmitterV2Abi, ERC20BridgeAbi } from './abis.js';

// ─── Solana Bridge (optional — requires @solana/web3.js for full Solana-side execution) ───
export {
  bridgeEVMToSolana,
  resumeEVMToSolana,
  receiveFromSolanaOnEVM,
  verifySolanaUsdcTokenAccount,
  bytes32ToSolanaPubkey,
  solanaPubkeyToBytes32,
  SPL_TOKEN_PROGRAM_ID,
  SOLANA_MAINNET_GENESIS_HASH,
  SolanaBridgeError,
  SOLANA_CCTP_DOMAIN,
  SOLANA_USDC_MINT,
  SOLANA_TOKEN_MESSENGER,
  SOLANA_MESSAGE_TRANSMITTER,
  SOLANA_DEFAULT_RPC,
} from './solana.js';
export type {
  EVMToSolanaOptions,
  EVMToSolanaResult,
  SolanaToEVMOptions,
  SolanaToEVMBurnParams,
  SolanaToEVMResult,
  SolanaBridgeErrorCode,
  SolanaBridgeRecovery,
  SolanaMintRecovery,
  VerifySolanaUsdcAccountOptions,
} from './solana.js';
