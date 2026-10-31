import {
  createPublicClient,
  http,
  getContract,
  parseEventLogs,
  parseAbi,
  isAddress,
  keccak256,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
  type PublicClient,
  type GetContractReturnType,
  type Chain,
  zeroAddress,
} from 'viem';
import {
  base, baseSepolia, mainnet, arbitrum, polygon, optimism, avalanche,
  unichain, linea, sonic, worldchain,
} from 'viem/chains';
import { AgentAccountV2Abi, AgentAccountFactoryV2Abi } from './abi.js';
import { AgentWalletVerificationError } from './wallet-verification-error.js';
import type {
  AgentWalletConfig,
  SpendPolicy,
  BudgetStatus,
  PendingTx,
  ExecuteResult,
  QueuedEvent,
  BudgetForecast,
  WalletHealth,
  ActivityEntry,
  BatchTransfer,
  AgentTransferResult,
} from './types.js';

export type {
  SpendPolicy, BudgetStatus, PendingTx, ExecuteResult, AgentWalletConfig, QueuedEvent,
  BudgetForecast, WalletHealth, ActivityEntry, BatchTransfer, AgentTransferResult,
} from './types.js';
export { AgentAccountV2Abi, AgentAccountFactoryV2Abi } from './abi.js';

// [MAX-ADDED] x402 protocol support
export {
  X402Client,
  X402BudgetTracker,
  X402PaymentError,
  X402BudgetExceededError,
  X402SettlementRevertedError,
  X402SettlementQueuedError,
  X402SettlementUnknownError,
  X402SettlementBacklogError,
  X402IntentTermsConflictError,
  X402PaidRequestError,
  encodeX402PaymentHeader,
  decodeX402PaymentHeader,
  X402_MAX_CHALLENGE_DEPTH,
  createX402Client,
  createX402Fetch,
  wrapWithX402,
  judgedSpotCheckNetwork,
  withSpotCheck,
  USDC_ADDRESSES,
  DEFAULT_SUPPORTED_NETWORKS,
  X402_PROTOCOL_FEE_BPS,
  X402_PROTOCOL_FEE_COLLECTOR,
  x402ProtocolFeeAmount,
  x402DebitAmount,
  classifyX402SettlementReceipt,
  // Stellar x402 (optional peer dependency @stellar/stellar-sdk, loaded lazily)
  StellarX402Adapter,
  StellarSpendBudget,
  stellarX402Pay,
  stellarAmountToStroops,
  StellarSubmissionUnknownError,
  StellarPaymentPolicyError,
  StellarTransactionRejectedError,
  STELLAR_NETWORK,
  STELLAR_USDC,
  STELLAR_RECONCILE_HISTORY_MARGIN_S,
} from './x402/index.js';
export type {
  X402SettlementTransfer,
  X402ReceiptClassification,
  StellarNetwork,
  StellarPaymentConfig,
  StellarPaymentRequest,
  StellarPaymentResult,
  StellarSpendPolicy,
  StellarTransactionLookup,
  StellarReconcileResult,
} from './x402/index.js';
export type {
  X402PaymentRequired,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402SettlementResponse,
  X402ResourceInfo,
  X402ServiceBudget,
  X402TransactionLog,
  X402ClientConfig,
  X402Fetch,
  SpotCheckChecker,
  SpotCheckClock,
  SpotCheckDecision,
  SpotCheckOptions,
} from './x402/index.js';

const CHAINS: Record<string, Chain> = {
  base,
  'base-sepolia': baseSepolia,
  ethereum: mainnet,
  arbitrum,
  polygon,
  optimism,
  avalanche,
  unichain,
  linea,
  sonic,
  worldchain,
};

/** Native ETH token address (zero address) */
export const NATIVE_TOKEN: Address = zeroAddress;

// ─── Core SDK Functions ───

/** Typed contract handle for an AgentAccountV2 bound to public + wallet clients. */
export type AgentAccountContract = GetContractReturnType<
  typeof AgentAccountV2Abi,
  { public: PublicClient; wallet: WalletClient }
>;

/** Wallet handle returned by {@link createWallet}. */
export interface AgentWalletHandle {
  address: Address;
  contract: AgentAccountContract;
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  /** Deployment identity supplied at creation; checked before writes. */
  deployment?: AgentWalletConfig['deployment'];
  expectedCodeHash?: Hash;
  allowUnverifiedDeployment?: boolean;
}

/** Own-property chain lookup: names like "constructor" or "__proto__" never resolve. */
function lookupChain(name: unknown): Chain | undefined {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(CHAINS, name)) return undefined;
  const chain = CHAINS[name];
  return chain && Number.isSafeInteger(chain.id) && chain.id > 0 ? chain : undefined;
}

/**
 * Read deployment-identity settings (env vars or plugin settings):
 * AGENT_WALLET_CODE_HASH, AGENT_WALLET_FACTORY + AGENT_WALLET_TOKEN_CONTRACT +
 * AGENT_WALLET_TOKEN_ID, and the unsafe AGENT_WALLET_ALLOW_UNVERIFIED=true.
 * Malformed nonempty values throw; blank values are treated as unset.
 */
export function readDeploymentIdentitySettings(
  get: (name: string) => string | undefined | null,
): Pick<AgentWalletConfig, 'deployment' | 'expectedCodeHash' | 'allowUnverifiedDeployment'> {
  const val = (k: string) => {
    const v = get(k);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const out: Pick<AgentWalletConfig, 'deployment' | 'expectedCodeHash' | 'allowUnverifiedDeployment'> = {};
  const codeHash = val('AGENT_WALLET_CODE_HASH');
  if (codeHash !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(codeHash)) throw new Error('AGENT_WALLET_CODE_HASH must be a 32-byte hex hash');
    out.expectedCodeHash = codeHash as Hash;
  }
  const factory = val('AGENT_WALLET_FACTORY');
  const tokenContract = val('AGENT_WALLET_TOKEN_CONTRACT');
  const tokenId = val('AGENT_WALLET_TOKEN_ID');
  if (factory !== undefined || tokenContract !== undefined || tokenId !== undefined) {
    if (!factory || !isAddress(factory, { strict: false }) || !tokenContract || !isAddress(tokenContract, { strict: false })
        || !tokenId || !/^\d{1,78}$/.test(tokenId)) {
      throw new Error('AGENT_WALLET_FACTORY, AGENT_WALLET_TOKEN_CONTRACT and AGENT_WALLET_TOKEN_ID must all be set and valid');
    }
    out.deployment = { factoryAddress: factory as Address, tokenContract: tokenContract as Address, tokenId: BigInt(tokenId) };
  }
  const allow = val('AGENT_WALLET_ALLOW_UNVERIFIED');
  if (allow !== undefined) {
    if (allow !== 'true' && allow !== 'false') throw new Error('AGENT_WALLET_ALLOW_UNVERIFIED must be "true" or "false"');
    out.allowUnverifiedDeployment = allow === 'true';
  }
  return out;
}

/**
 * Create a wallet client connected to an existing AgentAccountV2.
 */
export function createWallet(config: AgentWalletConfig & { walletClient: WalletClient }): AgentWalletHandle {
  const chain = lookupChain(config.chain);
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);
  if (typeof config.accountAddress !== 'string' || !isAddress(config.accountAddress, { strict: false })) {
    throw new Error('createWallet: accountAddress is not a valid address');
  }
  const signerChainId = config.walletClient?.chain?.id;
  if ((signerChainId !== undefined && signerChainId !== null) && signerChainId !== chain.id) {
    throw new Error(`createWallet: walletClient chain ${signerChainId} differs from ${config.chain} (${chain.id})`);
  }

  const publicClient: PublicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const contract: AgentAccountContract = getContract({
    address: config.accountAddress,
    abi: AgentAccountV2Abi,
    client: { public: publicClient, wallet: config.walletClient },
  });

  // Frozen: the verified address and the contract writes target can never diverge.
  return Object.freeze({
    address: config.accountAddress,
    contract,
    publicClient,
    walletClient: config.walletClient,
    chain,
    ...(config.deployment ? { deployment: Object.freeze({ ...config.deployment }) } : {}),
    ...(config.expectedCodeHash ? { expectedCodeHash: config.expectedCodeHash } : {}),
    ...(config.allowUnverifiedDeployment === true ? { allowUnverifiedDeployment: true } : {}),
  });
}

type Wallet = ReturnType<typeof createWallet>;

export { AgentWalletVerificationError };

const EIP7702_DELEGATION_PREFIX = '0xef0100';
const FACTORY_GET_ADDRESS_ABI = parseAbi([
  'function getAddress(address tokenContract, uint256 tokenId) view returns (address)',
]);
const verifiedWallets = new WeakMap<object, Promise<void>>();

/**
 * Verify, before any write, that `wallet.address` is a deployed AgentAccountV2
 * on `wallet.chain`: valid address, signer/read chain agreement, nonempty
 * non-delegated contract code, responsive account views, and — when supplied —
 * the approved code hash and the trusted factory's CREATE2 address.
 * Successful verification is cached per wallet handle; failures are retried.
 */
export async function verifyAgentWallet(wallet: Wallet): Promise<void> {
  const cached = verifiedWallets.get(wallet);
  if (cached) return cached;
  const pending = (async () => {
    const fail = (msg: string): never => { throw new AgentWalletVerificationError(`agent wallet ${wallet.address}: ${msg}`); };
    if (typeof wallet.address !== 'string' || !isAddress(wallet.address, { strict: false })) fail('invalid address');
    const contractAddress = (wallet.contract as { address?: unknown } | undefined)?.address;
    if (typeof contractAddress === 'string' && contractAddress.toLowerCase() !== wallet.address.toLowerCase()) {
      fail('wallet.contract.address differs from wallet.address');
    }
    if (!wallet.deployment && !wallet.expectedCodeHash && wallet.allowUnverifiedDeployment !== true) {
      fail('deployment identity required: pass `deployment` (trusted factory + token) or `expectedCodeHash` to createWallet() ' +
        '(env: AGENT_WALLET_FACTORY/AGENT_WALLET_TOKEN_CONTRACT/AGENT_WALLET_TOKEN_ID or AGENT_WALLET_CODE_HASH)');
    }
    const signerChain = wallet.walletClient?.chain?.id;
    if ((signerChain !== undefined && signerChain !== null) && signerChain !== wallet.chain.id) {
      fail(`signer chain ${signerChain} differs from wallet chain ${wallet.chain.id}`);
    }
    const readChain = wallet.publicClient?.chain?.id;
    if ((readChain !== undefined && readChain !== null) && readChain !== wallet.chain.id) {
      fail(`read client chain ${readChain} differs from wallet chain ${wallet.chain.id}`);
    }
    // `publicClient.chain` is static config: prove the read RPC endpoint itself
    // serves the wallet chain before trusting any deployment evidence from it.
    const assertReadChain = async (when: string) => {
      const rpcChain = await wallet.publicClient.getChainId();
      if (rpcChain !== wallet.chain.id) {
        fail(`read RPC serves chain ${rpcChain}, not the wallet chain ${wallet.chain.id} (${when})`);
      }
    };
    await assertReadChain('before deployment reads');
    const code = await wallet.publicClient.getCode({ address: wallet.address });
    if (!code || code === '0x') fail('no contract code at this address (EOA or undeployed)');
    if (code!.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) fail('address is an EIP-7702 delegated EOA, not an AgentAccountV2');
    if (wallet.expectedCodeHash && keccak256(code!).toLowerCase() !== wallet.expectedCodeHash.toLowerCase()) {
      fail('runtime code hash does not match expectedCodeHash');
    }
    const [tokenContract, tokenId] = await Promise.all([
      wallet.contract.read.tokenContract(),
      wallet.contract.read.tokenId(),
    ]).catch(err => fail(`does not answer AgentAccountV2 views: ${(err as Error).message}`)) as [Address, bigint];
    if (wallet.deployment) {
      const d = wallet.deployment;
      if (tokenContract.toLowerCase() !== d.tokenContract.toLowerCase() || tokenId !== d.tokenId) {
        fail('account token binding differs from the configured deployment');
      }
      const predicted = await wallet.publicClient.readContract({
        address: d.factoryAddress,
        abi: FACTORY_GET_ADDRESS_ABI,
        functionName: 'getAddress',
        args: [d.tokenContract, d.tokenId],
      }) as Address;
      if (predicted.toLowerCase() !== wallet.address.toLowerCase()) {
        fail('factory CREATE2 address does not match accountAddress');
      }
    }
    // Re-check after the reads so evidence from a mid-verification network
    // switch is discarded rather than cached.
    await assertReadChain('after deployment reads');
  })().catch((err: unknown) => {
    // Every failure here happens before any write: report it as a typed,
    // definite pre-broadcast verification failure (RPC errors included).
    if (err instanceof AgentWalletVerificationError) throw err;
    throw new AgentWalletVerificationError(
      `agent wallet ${wallet.address}: verification failed: ${err instanceof Error ? err.message : String(err)}`, err);
  });
  verifiedWallets.set(wallet, pending);
  pending.catch(() => verifiedWallets.delete(wallet));
  return pending;
}

/** Submitted execution that reverted or could not be confirmed. Do not resubmit an unknown execution. */
export class AgentExecutionError extends Error {
  readonly name = 'AgentExecutionError';
  constructor(
    readonly txHash: Hash,
    readonly executionStatus: 'reverted' | 'unknown',
    readonly cause?: unknown,
  ) {
    super(`Agent execution ${executionStatus}: ${txHash}`);
  }
}

/**
 * Set a spend policy for a token. Only callable by the NFT owner.
 * Use NATIVE_TOKEN (address(0)) for native ETH.
 */
export async function setSpendPolicy(
  wallet: Wallet,
  policy: SpendPolicy
): Promise<Hash> {
  const periodLength = policy.periodLength || 86400;
  await verifyAgentWallet(wallet);

  const hash = await wallet.contract.write.setSpendPolicy([
    policy.token,
    policy.perTxLimit,
    policy.periodLimit,
    BigInt(periodLength),
  ], { account: wallet.walletClient.account!, chain: wallet.chain });

  return hash;
}

/**
 * Execute a transaction as the agent. If within limits, executes immediately.
 * If over limits, queues for owner approval and returns the pending tx ID.
 */
export async function agentExecute(
  wallet: Wallet,
  params: { to: Address; value?: bigint; data?: Hex }
): Promise<ExecuteResult> {
  const value = params.value ?? 0n;
  const data = params.data ?? '0x';
  if (typeof value !== 'bigint' || value < 0n) throw new Error('agentExecute: value must be a non-negative bigint');
  await verifyAgentWallet(wallet);

  const hash = await wallet.contract.write.agentExecute([
    params.to,
    value,
    data,
  ], { value, account: wallet.walletClient.account!, chain: wallet.chain });

  // Classify only from positive evidence emitted by this wallet.
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash }).catch(error => {
    throw new AgentExecutionError(hash, 'unknown', error);
  });
  if (receipt.status !== 'success') {
    throw new AgentExecutionError(hash, receipt.status === 'reverted' ? 'reverted' : 'unknown');
  }

  const walletLogs = receipt.logs.filter(log => log.address.toLowerCase() === wallet.address.toLowerCase());
  const queuedLog = parseEventLogs({ abi: AgentAccountV2Abi, eventName: 'TransactionQueued', logs: walletLogs })
    // An agentExecute queue entry is a native call (token == NATIVE_TOKEN); a
    // queued token transfer to the same address (e.g. from a re-entrant target)
    // is a different action and must not mask this call's execution.
    .find(log =>
      log.args.to.toLowerCase() === params.to.toLowerCase() &&
      log.args.value === value &&
      log.args.token.toLowerCase() === NATIVE_TOKEN);
  if (queuedLog) {
    return { executed: false, txHash: hash, pendingTxId: queuedLog.args.txId };
  }
  const executedLog = parseEventLogs({ abi: AgentAccountV2Abi, eventName: 'TransactionExecuted', logs: walletLogs })
    .find(log =>
      log.args.target.toLowerCase() === params.to.toLowerCase() &&
      log.args.value === value &&
      log.args.data.toLowerCase() === data.toLowerCase());
  if (executedLog) {
    return { executed: true, txHash: hash };
  }
  // A successful outer receipt without either event is not execution evidence.
  throw new AgentExecutionError(hash, 'unknown');
}

/**
 * Check remaining autonomous budget for a token.
 */
export async function checkBudget(
  wallet: Wallet,
  token: Address = NATIVE_TOKEN
): Promise<BudgetStatus> {
  const [perTxLimit, remainingInPeriod] = await wallet.contract.read.remainingBudget([token]);

  return {
    token,
    perTxLimit,
    remainingInPeriod,
  };
}

/**
 * Get a pending transaction by ID.
 */
export async function getPendingApprovals(
  wallet: Wallet,
  fromId: bigint = 0n,
  toId?: bigint
): Promise<PendingTx[]> {
  const maxId = toId ?? await wallet.contract.read.pendingNonce();
  const results: PendingTx[] = [];

  for (let i = fromId; i < maxId; i++) {
    const [to, value, token, amount, createdAt, executed, cancelled] =
      await wallet.contract.read.getPending([i]);

    if (!executed && !cancelled && createdAt > 0n) {
      results.push({
        txId: i,
        to,
        value,
        data: '0x', // data not returned by getPending view
        token,
        amount,
        createdAt: Number(createdAt),
        executed,
        cancelled,
      });
    }
  }

  return results;
}

/**
 * Approve a pending transaction. Only callable by the NFT owner.
 */
export async function approveTransaction(
  wallet: Wallet,
  txId: bigint
): Promise<Hash> {
  await verifyAgentWallet(wallet);
  return wallet.contract.write.approvePending([txId], { account: wallet.walletClient.account!, chain: wallet.chain });
}

/**
 * Cancel a pending transaction. Only callable by the NFT owner.
 */
export async function cancelTransaction(
  wallet: Wallet,
  txId: bigint
): Promise<Hash> {
  await verifyAgentWallet(wallet);
  return wallet.contract.write.cancelPending([txId], { account: wallet.walletClient.account!, chain: wallet.chain });
}

/**
 * Add or remove an operator (agent hot wallet).
 */
export async function setOperator(
  wallet: Wallet,
  operator: Address,
  authorized: boolean
): Promise<Hash> {
  await verifyAgentWallet(wallet);
  return wallet.contract.write.setOperator([operator, authorized], { account: wallet.walletClient.account!, chain: wallet.chain });
}

const ERC20_TRANSFER_EVENT_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * Submit-only primitive: sends agentTransferToken and returns the outer
 * transaction hash. The hash is NOT settlement proof — the transfer may revert
 * or be queued for owner approval. Prefer {@link agentTransferToken}.
 */
export async function submitAgentTransferToken(
  wallet: Wallet,
  params: { token: Address; to: Address; amount: bigint }
): Promise<Hash> {
  if (typeof params.amount !== 'bigint' || params.amount <= 0n) {
    throw new Error('agentTransferToken: amount must be a positive bigint');
  }
  await verifyAgentWallet(wallet);
  return wallet.contract.write.agentTransferToken([
    params.token,
    params.to,
    params.amount,
  ], { account: wallet.walletClient.account!, chain: wallet.chain });
}

/**
 * Transfer ERC20 tokens as the agent, respecting spend limits, and classify
 * the confirmed receipt. Returns `executed` only when the token emitted a
 * matching Transfer(wallet → to, amount); `queued` when the wallet parked it
 * for owner approval (no tokens moved — do not release goods or retry).
 * Throws AgentExecutionError('reverted' | 'unknown') otherwise; never resubmit
 * an unknown transfer — reconcile its hash.
 */
export async function agentTransferToken(
  wallet: Wallet,
  params: { token: Address; to: Address; amount: bigint }
): Promise<AgentTransferResult> {
  const hash = await submitAgentTransferToken(wallet, params);
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash }).catch(error => {
    throw new AgentExecutionError(hash, 'unknown', error);
  });
  if (receipt.status !== 'success') {
    throw new AgentExecutionError(hash, receipt.status === 'reverted' ? 'reverted' : 'unknown');
  }
  const walletAddr = wallet.address.toLowerCase();
  // Only a queued entry for THIS transfer (recipient, token, amount, no
  // native value) means "queued"; an unrelated queued event must not mask a
  // matching Transfer or be reported as this payment's state.
  const queuedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    logs: receipt.logs.filter(log => log.address.toLowerCase() === walletAddr),
  }).find(log =>
    log.args.to.toLowerCase() === params.to.toLowerCase() &&
    log.args.token.toLowerCase() === params.token.toLowerCase() &&
    log.args.amount === params.amount &&
    log.args.value === 0n,
  );
  if (queuedLog) {
    return { status: 'queued', txHash: hash, pendingTxId: queuedLog.args.txId };
  }
  const transferred = parseEventLogs({
    abi: ERC20_TRANSFER_EVENT_ABI,
    eventName: 'Transfer',
    logs: receipt.logs.filter(log => log.address.toLowerCase() === params.token.toLowerCase()),
  }).some(log =>
    log.args.from.toLowerCase() === walletAddr &&
    log.args.to.toLowerCase() === params.to.toLowerCase() &&
    log.args.value === params.amount,
  );
  if (transferred) return { status: 'executed', txHash: hash };
  throw new AgentExecutionError(hash, 'unknown');
}

// ─── Factory: Deploy New Wallets ───

/**
 * Deploy a new AgentAccountV2 wallet via the factory (CREATE2).
 * Returns the deterministic wallet address.
 */
export async function deployWallet(config: {
  factoryAddress: Address;
  tokenContract: Address;
  tokenId: bigint;
  chain: keyof typeof CHAINS;
  rpcUrl?: string;
  walletClient: WalletClient;
}): Promise<{ walletAddress: Address; txHash: Hash }> {
  const chain = lookupChain(config.chain);
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const factory = getContract({
    address: config.factoryAddress,
    abi: AgentAccountFactoryV2Abi,
    client: { public: publicClient, wallet: config.walletClient },
  });

  // Get deterministic address first
  const walletAddress = await factory.read.getAddress([
    config.tokenContract,
    config.tokenId,
  ]) as Address;

  // Deploy
  const txHash = await factory.write.createAccount([
    config.tokenContract,
    config.tokenId,
  ], { account: config.walletClient.account!, chain });

  return { walletAddress, txHash };
}

/**
 * Compute the deterministic wallet address without deploying.
 */
export async function getWalletAddress(config: {
  factoryAddress: Address;
  tokenContract: Address;
  tokenId: bigint;
  chain: string;
  rpcUrl?: string;
}): Promise<Address> {
  const chain = lookupChain(config.chain);
  if (!chain) throw new Error(`Unsupported chain: ${config.chain}`);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const factory = getContract({
    address: config.factoryAddress,
    abi: AgentAccountFactoryV2Abi,
    client: publicClient,
  });

  return factory.read.getAddress([config.tokenContract, config.tokenId]) as Promise<Address>;
}

// ─── [MAX-ADDED] Value-Add Features for Agent Customers ───

/**
 * [MAX-ADDED] Budget forecast with period-aware remaining capacity.
 * Why: Agents need to know not just "how much is left" but "when does budget reset"
 * so they can plan spending across time windows and avoid unnecessary queuing.
 */
export async function getBudgetForecast(
  wallet: Wallet,
  token: Address = NATIVE_TOKEN,
  now?: number
): Promise<BudgetForecast> {
  const [perTxLimit, remainingInPeriod] = await wallet.contract.read.remainingBudget([token]);
  const [_policyPerTx, periodLimit, periodLength, periodSpent, periodStart] =
    await wallet.contract.read.spendPolicies([token]);

  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const periodEnd = Number(periodStart) + Number(periodLength);
  const secondsUntilReset = Math.max(0, periodEnd - currentTime);
  const utilizationPercent = periodLimit > 0n
    ? Number((periodSpent * 100n) / periodLimit)
    : 0;

  return {
    token,
    perTxLimit,
    remainingInPeriod,
    periodLimit,
    periodLength: Number(periodLength),
    periodSpent,
    periodStart: Number(periodStart),
    secondsUntilReset,
    utilizationPercent,
  };
}

/**
 * [MAX-ADDED] Wallet health check — diagnostic snapshot for agent self-monitoring.
 * Why: Agents need a single-call way to verify their wallet is properly configured,
 * check operator status, and monitor queue depth before executing transactions.
 */
export async function getWalletHealth(
  wallet: Wallet,
  operatorsToCheck: Address[] = [],
  tokensToCheck: Address[] = [NATIVE_TOKEN],
  now?: number
): Promise<WalletHealth> {
  // Read wallet identity
  const [tokenContract, tokenId, operatorEpoch] = await Promise.all([
    wallet.contract.read.tokenContract(),
    wallet.contract.read.tokenId(),
    wallet.contract.read.operatorEpoch(),
  ]);

  // Check operator status
  const activeOperators = await Promise.all(
    operatorsToCheck.map(async (addr) => ({
      address: addr,
      active: await wallet.contract.read.isOperatorActive([addr]) as boolean,
    }))
  );

  // Count pending queue depth
  const pendingNonce = await wallet.contract.read.pendingNonce() as bigint;
  let pendingQueueDepth = 0;
  for (let i = 0n; i < pendingNonce; i++) {
    const [, , , , createdAt, executed, cancelled] = await wallet.contract.read.getPending([i]) as [any, any, any, any, bigint, boolean, boolean];
    if (!executed && !cancelled && createdAt > 0n) pendingQueueDepth++;
  }

  // Budget forecasts for requested tokens
  const budgets = await Promise.all(
    tokensToCheck.map((t) => getBudgetForecast(wallet, t, now))
  );

  return {
    address: wallet.address,
    tokenContract: tokenContract as Address,
    tokenId: tokenId as bigint,
    operatorEpoch: operatorEpoch as bigint,
    activeOperators,
    pendingQueueDepth,
    budgets,
  };
}

/**
 * Batch agent token transfers — sequential, individually confirmed transfers.
 * Returns one classified AgentTransferResult per transfer (`executed` or
 * `queued`); a queued transfer moved no tokens. Each is a separate on-chain tx.
 */
export async function batchAgentTransfer(
  wallet: Wallet,
  transfers: BatchTransfer[]
): Promise<AgentTransferResult[]> {
  // Each transfer is confirmed and classified before the next is sent. On an
  // error the classified results so far are attached as `error.completed`;
  // never resend those, and reconcile the failing transfer's hash.
  const results: AgentTransferResult[] = [];
  for (const t of transfers) {
    try {
      results.push(await agentTransferToken(wallet, t));
    } catch (err) {
      if (err && typeof err === 'object') Object.assign(err, { completed: [...results] });
      throw err;
    }
  }
  return results;
}

/**
 * [MAX-ADDED] Activity history — query past wallet events for self-auditing.
 * Why: Agents need to verify what happened on-chain (transfers, operator changes,
 * policy updates) without relying on external indexers. This queries event logs directly.
 */
export async function getActivityHistory(
  wallet: Wallet,
  options: { fromBlock?: bigint; toBlock?: bigint } = {}
): Promise<ActivityEntry[]> {
  const fromBlock = options.fromBlock ?? 0n;
  const toBlock = options.toBlock ?? 'latest' as any;

  const eventConfigs = [
    { eventName: 'TransactionExecuted' as const, type: 'execution' as const },
    { eventName: 'TransactionQueued' as const, type: 'queued' as const },
    { eventName: 'TransactionApproved' as const, type: 'approved' as const },
    { eventName: 'TransactionCancelled' as const, type: 'cancelled' as const },
    { eventName: 'SpendPolicyUpdated' as const, type: 'policy_update' as const },
    { eventName: 'OperatorUpdated' as const, type: 'operator_update' as const },
  ];

  const allEntries: ActivityEntry[] = [];

  for (const { eventName, type } of eventConfigs) {
    const logs = await wallet.publicClient.getContractEvents({
      address: wallet.address,
      abi: AgentAccountV2Abi,
      eventName,
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      allEntries.push({
        type,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: log.transactionHash ?? ('0x' as Hash),
        args: (log as any).args ?? {},
      });
    }
  }

  // Sort by block number ascending
  allEntries.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  return allEntries;
}

// ─── Event Listeners ───

/**
 * Watch for TransactionQueued events (over-limit transactions needing approval).
 * Returns an unwatch function.
 */
export function onTransactionQueued(
  wallet: Wallet,
  callback: (event: QueuedEvent) => void
): () => void {
  return wallet.publicClient.watchContractEvent({
    address: wallet.address,
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    onLogs: (logs) => {
      for (const log of logs) {
        const args = (log as any).args;
        callback({
          txId: args.txId,
          to: args.to,
          value: args.value,
          token: args.token,
          amount: args.amount,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        });
      }
    },
  });
}

/**
 * Watch for TransactionExecuted events.
 */
export function onTransactionExecuted(
  wallet: Wallet,
  callback: (event: { target: Address; value: bigint; executor: Address; transactionHash: Hash }) => void
): () => void {
  return wallet.publicClient.watchContractEvent({
    address: wallet.address,
    abi: AgentAccountV2Abi,
    eventName: 'TransactionExecuted',
    onLogs: (logs) => {
      for (const log of logs) {
        const args = (log as any).args;
        callback({
          target: args.target,
          value: args.value,
          executor: args.executor,
          transactionHash: log.transactionHash!,
        });
      }
    },
  });
}

// ─── ERC-8004: Trustless Agents — Identity Registry ─────────────────────────
export {
  ERC8004Client, ERC8004IdentityRegistryAbi, METADATA_KEYS,
  REGISTRATION_FILE_TYPE, KNOWN_REGISTRY_ADDRESSES,
  buildDataURI, parseDataURI, resolveAgentURI, validateRegistrationFile, formatAgentRegistry,
} from './identity/erc8004.js';
export type {
  AgentServiceEndpoint, SupportedTrustMechanism, AgentRegistrationRef,
  AgentRegistrationFile, AgentModelMetadata, AgentIdentity,
  MetadataEntry, ERC8004ClientConfig, RegistrationResult, SupportedChain,
  AgentURIResolver, AgentURIResolverContext, AgentURIResolutionOptions,
} from './identity/erc8004.js';

// ─── ERC-8004: Reputation Registry ─────────────────────────────────────────
export { ReputationClient, ReputationRegistryAbi } from './identity/reputation.js';
export type {
  ReputationClientConfig, GiveFeedbackParams, FeedbackEntry,
  AgentReputationSummary, FeedbackFilters, RespondToFeedbackParams,
} from './identity/reputation.js';

// ─── ERC-8004: Validation Registry ─────────────────────────────────────────
export { ValidationClient, ValidationRegistryAbi } from './identity/validation.js';
export type {
  ValidationClientConfig, RequestValidationParams, RespondToValidationParams,
  ValidationStatus, ValidationSummary,
} from './identity/validation.js';

// ─── UAID: Cross-Chain Identity Resolution (HOL Registry Broker) ────────────
export { UAIDResolver } from './identity/uaid.js';
export type {
  UAIDProtocol, ParsedUAID, UAIDResolution, UniversalAgentIdentity,
  UAIDResolverConfig, RegisterUAIDParams, UAIDVerification,
} from './identity/uaid.js';

// ─── SwapModule — Uniswap V3 token swap aggregator ──────────────────────────
export { SwapModule, attachSwap, calcProtocolFee, applySlippage, calcDeadline } from './swap/index.js';
export { UniswapV3RouterAbi, UniswapV3QuoterV2Abi, ERC20Abi } from './swap/index.js';
export { BASE_TOKENS, UNISWAP_V3_BASE, PROTOCOL_FEE_BPS, PROTOCOL_FEE_COLLECTOR, DEFAULT_SLIPPAGE_BPS } from './swap/index.js';
export type { UniswapFeeTier, SwapQuote, SwapOptions, SwapResult, SwapModuleConfig } from './swap/index.js';
export { ARBITRUM_TOKENS, OPTIMISM_TOKENS, POLYGON_TOKENS, UNISWAP_V3_ADDRESSES } from './swap/index.js';
export type { SwapChain } from './swap/index.js';

// ─── CCTP V2 Cross-Chain Bridge ─────────────────────────────────────────────
export {
  BridgeModule, BridgeError, createBridge,
  CCTP_DOMAIN_IDS, BRIDGE_CHAIN_IDS, USDC_CONTRACT,
  TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, FINALITY_THRESHOLD,
} from './bridge/index.js';
export { TokenMessengerV2Abi, MessageTransmitterV2Abi, ERC20BridgeAbi } from './bridge/index.js';
export type { BridgeChain, BridgeOptions, BurnResult, BridgeResult, BridgeRecovery, CctpAttestedMessage } from './bridge/index.js';
export { decodeCctpV2Message, assertBurnTerms } from './bridge/index.js';
export type { DecodedCctpV2Message, ExpectedBurnTerms, AttestationSelector } from './bridge/index.js';
// EVM↔Solana CCTP V2 (Solana-side execution needs the optional @solana/web3.js).
export {
  bridgeEVMToSolana,
  resumeEVMToSolana,
  receiveFromSolanaOnEVM,
  resumeSolanaToEVM,
  verifySolanaUsdcTokenAccount,
  bytes32ToSolanaPubkey,
  solanaPubkeyToBytes32,
  SolanaBridgeError,
  SOLANA_CCTP_DOMAIN,
  SPL_TOKEN_PROGRAM_ID,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_USDC_MINT,
  SOLANA_TOKEN_MESSENGER,
  SOLANA_MESSAGE_TRANSMITTER,
  SOLANA_DEFAULT_RPC,
} from './bridge/index.js';
export type { EVMBridgeChain, AttestationResponse, AttestationStatus } from './bridge/index.js';
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
} from './bridge/index.js';

// x402 already exported above from original index.ts; the rest of its public API:
export {
  x402SettlementReceiptIsQueued,
  X402_TRANSACTION_QUEUED_TOPIC,
  AbstractDelegatedFacilitatorAdapter,
  ABSTRACT_CHAIN_IDS,
  ABSTRACT_USDC,
  ABSTRACT_ANVIL_FACILITATOR,
  ABSTRACT_APPROVED_FACILITATORS,
  ABSTRACT_TESTNET_APPROVED_FACILITATORS,
  ABSTRACT_SUPPORTED_CHAINS,
  getAbstractApprovedFacilitators,
  assertAbstractFacilitatorApproved,
} from './x402/index.js';
export type { AbstractDelegatedPaymentConfig, DelegatedPaymentPermit, AbstractPaymentResult } from './x402/index.js';

// ─── Spend outcomes — reserve → execute → settle | release | hold-unknown ───
export {
  classifySpendAttempt,
  classifySpendError,
  isEvmTxHash,
} from './outcomes/index.js';
export type {
  SpendOutcome,
  SpendOutcomeStatus,
  SpendReceiptLike,
  ClassifySpendAttemptInput,
} from './outcomes/index.js';

// ─── SpendingPolicy — Programmable spending guardrails ───────────────────────
export {
  SpendingPolicy,
  debitAmountForPolicy,
  snapshotPaymentIntent,
} from './policy/SpendingPolicy.js';
export type {
  SpendingPolicyConfig,
  PaymentIntent,
  PolicyResult,
  PolicyStatus,
  ReserveResult,
  ReserveStatus,
  ReservationStatus,
  SpendReservation,
  AuditStatus,
  AuditEntry,
  DraftEntry,
  SubmissionIdentity,
  SubmissionCall,
  ReconciliationClient,
  ReconcileResult,
  ReconcileStatus,
} from './policy/SpendingPolicy.js';

// ─── UptoBillingPolicy — x402 usage-based settlement accounting ─────────────
export {
  UptoBillingPolicy,
} from './policy/UptoBillingPolicy.js';
export type {
  UptoAuthorizationStatus,
  UptoAuthorizationRequest,
  UptoSettlementOptions,
  UptoSettlementRecord,
  UptoAuthorizationRecord,
  WalletLedgerDelta,
  UptoBillingSnapshot,
} from './policy/UptoBillingPolicy.js';

// ─── Mutual Stake Escrow ─────────────────────────────────────────────────────
export { MutualStakeEscrow } from './escrow/MutualStakeEscrow.js';
export type {
  CreateEscrowParams,
  EscrowCreated,
  EscrowDetails,
  TxResult as EscrowTxResult,
} from './escrow/types.js';
export { TaskStatus } from './escrow/types.js';
export {
  resolveVerifierAddress,
  encodeHashVerifierData,
  encodeOptimisticVerifierData,
  VERIFIER_ADDRESSES,
} from './escrow/verifiers.js';

// ─── Convenience: env-variable-driven wallet bootstrap ──────────────────────
export {
  walletFromEnv,
  setPolicyFromEnv,
  x402FromEnv,
} from './convenience.js';
// ─── v6: Multi-Token Support ─────────────────────────────────────────────────

// TokenRegistry — pre-populated multi-chain token address registry
export {
  TokenRegistry,
  getGlobalRegistry,
  getNativeToken,
  ETHEREUM_REGISTRY,
  BASE_REGISTRY,
  ARBITRUM_REGISTRY,
  OPTIMISM_REGISTRY,
  POLYGON_REGISTRY,
  AVALANCHE_REGISTRY,
  UNICHAIN_REGISTRY,
  LINEA_REGISTRY,
  SONIC_REGISTRY,
  WORLDCHAIN_REGISTRY,
  BASE_SEPOLIA_REGISTRY,
} from './tokens/registry.js';
export type { TokenEntry, AddTokenParams } from './tokens/registry.js';

// Token decimal normalization
export { toRaw, toHuman, formatBalance, parseAmount, parseExactAmount, assertTokenDecimals, MAX_TOKEN_DECIMALS } from './tokens/decimals.js';
export type { TokenInfo } from './tokens/decimals.js';

// Multi-token EVM transfers (direct EOA/hot-wallet operations)
export {
  sendToken,
  sendNative,
  getTokenBalance,
  getNativeBalance,
  getBalances,
  encodeERC20Transfer,
  TokenTransferSafetyError,
} from './tokens/transfers.js';
export type {
  TransferContext,
  TransferOptions,
  TokenBalanceResult,
  NativeBalanceResult,
} from './tokens/transfers.js';

// Solana SPL token support (optional peer dependency: @solana/web3.js)
export { SolanaWallet, createSolanaWallet, SOLANA_TOKENS, SOLANA_TOKEN_DECIMALS, SOLANA_CLUSTER_GENESIS_HASHES, SolanaTransferSafetyError } from './tokens/solana.js';
export type {
  SolanaWalletConfig,
  SolanaTokenInfo,
  SolanaTokenSymbol,
  SolBalanceResult,
  SplBalanceResult,
  SolanaTxResult,
  SolanaCluster,
  SendSplTokenOptions,
} from './tokens/solana.js';

// x402 multi-asset resolution (v6 additions)
export {
  resolveAssetAddress,
  resolveAssetDecimals,
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
} from './x402/multi-asset.js';

// ─── Payment Router ───────────────────────────────────────────────────────────
export { PaymentRouter } from './router/index.js';
export type {
  PaymentRail,
  RailStatus,
  RailConfig,
  PaymentContext,
  RoutingDecision,
} from './router/index.js';

export { normalizeCircleAgentPaymentReceipt } from './receipts/index.js';
export type { AgentPaymentMode, CircleAgentPaymentInput, PortableAgentPaymentReceipt } from './receipts/index.js';
