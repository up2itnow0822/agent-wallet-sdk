using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine.Networking;

namespace AgentWallet.X402
{
    /// <summary>
    /// Default transport that executes HTTP requests with UnityWebRequest.
    /// </summary>
    public class UnityWebRequestTransport : IX402Transport
    {
        public async Task<RawResponse> SendAsync(
            string url,
            string method,
            string body,
            Dictionary<string, string> headers,
            int timeoutSeconds
        )
        {
            using var request = new UnityWebRequest(url, method);

            request.timeout = timeoutSeconds > 0 ? timeoutSeconds : 30;

            if (body != null)
            {
                request.uploadHandler =
                    new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                request.SetRequestHeader("Content-Type", "application/json");
            }

            request.downloadHandler = new DownloadHandlerBuffer();

            if (headers != null)
            {
                foreach (var kv in headers)
                {
                    request.SetRequestHeader(kv.Key, kv.Value);
                }
            }

            var operation = request.SendWebRequest();
            while (!operation.isDone)
            {
                await Task.Yield();
            }

            var responseHeaders = new Dictionary<string, string>();
            foreach (var key in request.GetResponseHeaders()?.Keys
                ?? new Dictionary<string, string>().Keys)
            {
                responseHeaders[key.ToUpperInvariant()] =
                    request.GetResponseHeader(key);
            }

            return new RawResponse
            {
                StatusCode = (int)request.responseCode,
                Body = request.downloadHandler?.text,
                Headers = responseHeaders
            };
        }
    }
}
