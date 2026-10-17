import type { BridgeRecovery } from './types.js';

export class BridgeError extends Error {
  readonly code: string;
  readonly recovery?: BridgeRecovery;
  constructor(code: string, message: string, recovery?: BridgeRecovery) {
    super(`[BridgeModule:${code}] ${message}`);
    this.code = code;
    this.recovery = recovery;
    this.name = 'BridgeError';
  }
}

export function withBridgeRecovery(error: unknown, recovery: BridgeRecovery, fallbackCode: string): BridgeError {
  const code = error instanceof BridgeError ? error.code : fallbackCode;
  const detail = error instanceof Error ? error.message.replace(/^\[BridgeModule:[^\]]+\] /, '') : String(error);
  return new BridgeError(code, `${detail} Resume the existing burn transaction ${recovery.burnTxHash}; do not burn again.`, {
    ...recovery,
    ...(error instanceof BridgeError ? error.recovery : {}),
  });
}
