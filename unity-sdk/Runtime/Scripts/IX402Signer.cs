using System.Threading.Tasks;

namespace AgentWallet.X402
{
    /// <summary>
    /// Interface for x402 payment signing. Implement this to connect
    /// your wallet backend (custodial API, local keystore, hardware signer).
    /// </summary>
    public interface IX402Signer
    {
        /// <summary>
        /// Sign a payment request and return the base64-encoded payment payload
        /// for the X-PAYMENT header.
        /// </summary>
        Task<string> SignPaymentAsync(PaymentRequest request);

        /// <summary>
        /// Get the wallet address used for signing.
        /// </summary>
        string GetAddress();
    }
}
