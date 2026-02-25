export {
  BridgeModule, BridgeError, createBridge,
  CCTP_DOMAIN_IDS, BRIDGE_CHAIN_IDS, USDC_CONTRACT,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, FINALITY_THRESHOLD,
} from './client.js';
export type {
  BridgeChain, BridgeOptions, BurnResult, BridgeResult, AttestationResponse, AttestationStatus,
} from './types.js';
export { TokenMessengerV2Abi, MessageTransmitterV2Abi, ERC20BridgeAbi } from './abis.js';
