using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace AgentWallet.X402
{
    /// <summary>
    /// MonoBehaviour wrapper for x402 payments. Attach to any GameObject
    /// to give an NPC or agent the ability to pay for API calls.
    /// </summary>
    public class X402AgentBehaviour : MonoBehaviour
    {
        [Header("Spending Limits")]
        [Tooltip("Max USDC this agent can spend per session")]
        public float maxSessionSpend = 1.0f;

        [Tooltip("Max USDC per single payment")]
        public float maxSinglePayment = 0.10f;

        [Header("Network")]
        [Tooltip("Blockchain for payments")]
        public string chain = "base";

        [Tooltip("Payment token")]
        public string token = "USDC";

        [Header("Wallet")]
        [Tooltip("Hex private key (dev only - use HardwareSigner in production)")]
        public string devPrivateKey = "";

        [Tooltip("Wallet address")]
        public string walletAddress = "";

        private X402Client _client;

        public X402Client Client => _client;

        void Awake()
        {
            var config = new X402Config
            {
                MaxSessionSpend = (decimal)maxSessionSpend,
                MaxSinglePayment = (decimal)maxSinglePayment,
                DefaultChain = chain,
                DefaultToken = token
            };

            IX402Signer signer;
            if (!string.IsNullOrEmpty(devPrivateKey))
            {
                signer = new LocalKeySigner(devPrivateKey, walletAddress);
            }
            else
            {
                Debug.LogWarning("[x402] No signer configured. Payments will fail. Set devPrivateKey or provide a custom IX402Signer.");
                return;
            }

            _client = new X402Client(config, signer);
            Debug.Log($"[x402] Agent wallet initialized: {walletAddress} on {chain}");
        }

        /// <summary>
        /// Convenience method: GET request with automatic x402 payment.
        /// </summary>
        public async Task<X402Response> GetAsync(string url, Dictionary<string, string> headers = null)
        {
            return await _client.SendAsync(url, "GET", null, headers);
        }

        /// <summary>
        /// Convenience method: POST request with automatic x402 payment.
        /// </summary>
        public async Task<X402Response> PostAsync(string url, string jsonBody, Dictionary<string, string> headers = null)
        {
            return await _client.SendAsync(url, "POST", jsonBody, headers);
        }

        /// <summary>
        /// Get total USDC spent this session.
        /// </summary>
        public decimal GetSessionSpend() => _client?.SessionSpent ?? 0;

        void OnDestroy()
        {
            if (_client != null)
            {
                Debug.Log($"[x402] Agent session ended. Total spent: {_client.SessionSpent} USDC across {_client.PaymentHistory.Count} payments.");
            }
        }
    }
}
