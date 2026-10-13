/** CCTP V2 wire format and IRIS schema: https://developers.circle.com/cctp/references/technical-guide */
import { decodeAbiParameters, keccak256, type Hex, type Hash } from 'viem';
import { BridgeError } from './errors.js';
import { ATTESTATION_POLL_INTERVAL_MS, MAX_ATTESTATION_POLLS, type AttestedMessage, type BurnResult } from './types.js';

export interface CctpMessage {
  sourceDomain: number;
  destinationDomain: number;
  nonce: bigint;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
}

function bytes(message: Hex, start: number, end?: number): Hex {
  return `0x${message.slice(2 + start * 2, end === undefined ? undefined : 2 + end * 2)}`;
}

/** Decode the V2 header (148 bytes) and burn body (228 bytes plus optional hooks). */
export function parseCctpMessage(message: unknown): CctpMessage {
  if (typeof message !== 'string' || !/^0x(?:[a-fA-F0-9]{2}){376,}$/.test(message)) {
    throw new BridgeError('ATTESTATION_ERROR', 'Expected a complete CCTP V2 burn message.');
  }
  const hex = message.toLowerCase() as Hex;
  const integer = (start: number, length: number) => BigInt(bytes(hex, start, start + length));
  if (integer(0, 4) !== 1n || integer(148, 4) !== 1n) {
    throw new BridgeError('ATTESTATION_ERROR', 'Unsupported CCTP message or burn-body version.');
  }
  return {
    sourceDomain: Number(integer(4, 4)), destinationDomain: Number(integer(8, 4)), nonce: integer(12, 32),
    sender: bytes(hex, 44, 76), recipient: bytes(hex, 76, 108), destinationCaller: bytes(hex, 108, 140),
    minFinalityThreshold: Number(integer(140, 4)), finalityThresholdExecuted: Number(integer(144, 4)),
    burnToken: bytes(hex, 152, 184), mintRecipient: bytes(hex, 184, 216), amount: integer(216, 32),
    messageSender: bytes(hex, 248, 280), maxFee: integer(280, 32), feeExecuted: integer(312, 32), expirationBlock: integer(344, 32),
  };
}

export function assertMessageFields(actual: CctpMessage, expected: Partial<CctpMessage>, code = 'BURN_FAILED'): void {
  for (const key of Object.keys(expected) as Array<keyof CctpMessage>) {
    const a = actual[key];
    const b = expected[key];
    if (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() !== b.toLowerCase() : a !== b) {
      throw new BridgeError(code, `CCTP message ${key} does not match the expected transfer.`);
    }
  }
}

export function evmMintRecipient(message: CctpMessage): `0x${string}` {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(message.mintRecipient)) {
    throw new BridgeError('INVALID_RECIPIENT', 'CCTP mintRecipient is not an EVM address.');
  }
  return `0x${message.mintRecipient.slice(26)}`;
}

export function assertAttestedMessage(message: CctpMessage, attestation: unknown, code = 'ATTESTATION_ERROR'): asserts attestation is Hex {
  const requiredFinality = message.minFinalityThreshold <= 1000 ? 1000 : 2000;
  if (typeof attestation !== 'string' || !/^0x(?:[a-fA-F0-9]{130})+$/.test(attestation) || message.nonce === 0n ||
      ![1000, 2000].includes(message.finalityThresholdExecuted) || message.finalityThresholdExecuted < requiredFinality ||
      message.feeExecuted > message.maxFee || message.feeExecuted >= message.amount) {
    throw new BridgeError(code, 'Invalid completed V2 attestation, nonce, finality or executed fee.');
  }
}

/** Require the authenticated source transmitter log and exactly one matching burn. */
export function extractBurnResult(
  receipt: { status: string; transactionHash: Hash; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] },
  burnTxHash: Hash,
  transmitterAddress: string,
  expected: Partial<CctpMessage>,
): BurnResult {
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== burnTxHash.toLowerCase()) {
    throw new BridgeError('BURN_FAILED', `Burn transaction was not confirmed successful: ${burnTxHash}.`);
  }
  const matches: BurnResult[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== transmitterAddress.toLowerCase() || log.topics[0]?.toLowerCase() !== '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036') continue;
    try {
      const [messageBytes] = decodeAbiParameters([{ type: 'bytes' }], log.data);
      const decoded = parseCctpMessage(messageBytes);
      assertMessageFields(decoded, expected);
      matches.push({ burnTxHash, messageBytes, messageHash: keccak256(messageBytes), nonce: decoded.nonce, sourceDomain: decoded.sourceDomain, destinationDomain: decoded.destinationDomain });
    } catch {
      // Another message in the same transaction may belong to a different transfer.
    }
  }
  if (matches.length !== 1) {
    throw new BridgeError('BURN_FAILED', 'Expected exactly one matching MessageSent event from the source CCTP transmitter.');
  }
  return matches[0];
}

function sameBurn(source: Hex, attested: Hex): boolean {
  // Iris assigns nonce, executed finality, executed fee and expiration offchain.
  // Every other byte, including the full burn intent and any hook data, must match.
  return [[0, 12], [44, 144], [148, 312], [376, undefined]].every(([start, end]) =>
    bytes(source, start!, end).toLowerCase() === bytes(attested, start!, end).toLowerCase(),
  );
}

/** Fetch the signed V2 message by source transaction, never by pre-attestation message hash. */
export async function pollForAttestation(burnTxHash: string, sourceMessage: Hex, apiUrl: string): Promise<AttestedMessage> {
  const source = parseCctpMessage(sourceMessage);
  const url = `${apiUrl.replace(/\/$/, '')}/v2/messages/${source.sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`;
  for (let attempt = 0; attempt < MAX_ATTESTATION_POLLS; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        if (res.status !== 404) throw new BridgeError('ATTESTATION_ERROR', `Circle API returned HTTP ${res.status}.`);
      } else {
        const response: unknown = await res.json();
        if (!response || typeof response !== 'object' || !('messages' in response) || !Array.isArray(response.messages) || !('sourceTxHash' in response) || typeof response.sourceTxHash !== 'string' ||
            (burnTxHash.startsWith('0x') ? response.sourceTxHash.toLowerCase() !== burnTxHash.toLowerCase() : response.sourceTxHash !== burnTxHash)) {
          throw new BridgeError('ATTESTATION_ERROR', 'Invalid Circle V2 response or mismatched source transaction.');
        }
        const matching: Array<{ message: Hex; attestation: unknown; status: string; decoded: CctpMessage }> = [];
        let pending = response.messages.length === 0;
        for (const entry of response.messages) {
          if (!entry || typeof entry !== 'object' || typeof entry.status !== 'string' || ![1, 2].includes(entry.cctpVersion)) {
            throw new BridgeError('ATTESTATION_ERROR', 'Malformed Circle message entry.');
          }
          if (entry.cctpVersion === 1) continue;
          if (entry.status === 'error') throw new BridgeError('ATTESTATION_ERROR', 'Circle could not attest the source burn.');
          if (entry.status !== 'complete' && entry.status !== 'pending_confirmations') {
            throw new BridgeError('ATTESTATION_ERROR', 'Unrecognized Circle attestation status.');
          }
          if (entry.status === 'pending_confirmations' && (!entry.message || entry.message === '0x')) { pending = true; continue; }
          const decoded = parseCctpMessage(entry.message);
          if (!sameBurn(sourceMessage, entry.message)) continue;
          matching.push({ message: entry.message, attestation: entry.attestation, status: entry.status, decoded });
        }
        if (matching.length > 1) throw new BridgeError('ATTESTATION_ERROR', 'Ambiguous Circle response: multiple messages match the source burn.');
        if (matching.length === 1) {
          const match = matching[0];
          if (match.status === 'pending_confirmations') pending = true;
          else {
            assertAttestedMessage(match.decoded, match.attestation);
            return { burnTxHash, message: match.message, messageHash: keccak256(match.message), attestation: match.attestation, nonce: match.decoded.nonce };
          }
        }
        if (!pending) throw new BridgeError('ATTESTATION_ERROR', 'Circle response does not contain the expected source burn.');
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('ATTESTATION_ERROR', `Failed to fetch Circle V2 attestation: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (attempt + 1 < MAX_ATTESTATION_POLLS) await new Promise<void>(resolve => setTimeout(resolve, ATTESTATION_POLL_INTERVAL_MS));
  }
  throw new BridgeError('ATTESTATION_TIMEOUT', `Attestation not received after ${MAX_ATTESTATION_POLLS} attempts for burn transaction ${burnTxHash}.`);
}
