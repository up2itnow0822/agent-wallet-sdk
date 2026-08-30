using System;

namespace AgentWallet.X402
{
    /// <summary>
    /// Configuration for the x402 Unity client.
    /// </summary>
    [Serializable]
    public class X402Config
    {
        /// <summary>
        /// Maximum USDC the client can spend per session before refusing new payments.
        /// Set to 0 for unlimited (not recommended for autonomous agents).
        /// </summary>
        public decimal MaxSessionSpend = 1.00m;

        /// <summary>
        /// Maximum single payment amount. Payments above this are rejected.
        /// </summary>
        public decimal MaxSinglePayment = 0.10m;

        /// <summary>
        /// Default chain for payments. "base" | "ethereum" | "solana"
        /// </summary>
        public string DefaultChain = "base";

        /// <summary>
        /// Default payment token. "USDC" | "EURC"
        /// </summary>
        public string DefaultToken = "USDC";

        /// <summary>
        /// Whether to log payment details to Unity console.
        /// </summary>
        public bool VerboseLogging = true;

        /// <summary>
        /// Timeout in seconds for HTTP requests.
        /// </summary>
        public int RequestTimeoutSeconds = 30;

        /// <summary>
        /// RPC endpoint for Base network. Required for on-chain signing.
        /// </summary>
        public string BaseRpcUrl = "https://mainnet.base.org";
    }
}
