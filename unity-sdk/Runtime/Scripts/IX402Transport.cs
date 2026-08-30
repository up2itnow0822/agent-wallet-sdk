using System.Collections.Generic;
using System.Threading.Tasks;

namespace AgentWallet.X402
{
    /// <summary>
    /// Transport abstraction for x402 requests. The default implementation uses
    /// UnityWebRequest, while tests can supply a deterministic transport.
    /// </summary>
    public interface IX402Transport
    {
        Task<RawResponse> SendAsync(
            string url,
            string method,
            string body,
            Dictionary<string, string> headers,
            int timeoutSeconds
        );
    }
}
