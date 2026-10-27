/**
 * Thrown before signing when the configured account cannot be verified as an
 * AgentAccountV2 deployment. Always a definite pre-broadcast failure: no write
 * was attempted, so callers may release any budget reserved for the call.
 */
export class AgentWalletVerificationError extends Error {
  readonly name = 'AgentWalletVerificationError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}
