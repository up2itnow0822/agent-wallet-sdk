using System;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

namespace AgentWallet.X402
{
    /// <summary>
    /// Local key signer for development and testing. Stores a private key in memory
    /// and signs x402 payment payloads. NOT recommended for production - use
    /// HardwareSigner or a custodial API signer instead.
    /// </summary>
    public class LocalKeySigner : IX402Signer
    {
        private readonly byte[] _privateKey;
        private readonly string _address;

        /// <summary>
        /// Create a signer from a hex-encoded private key.
        /// </summary>
        public LocalKeySigner(string privateKeyHex, string address)
        {
            if (string.IsNullOrEmpty(privateKeyHex))
                throw new ArgumentException("Private key cannot be empty");

            _privateKey = HexToBytes(privateKeyHex);
            _address = address ?? throw new ArgumentNullException(nameof(address));
        }

        public string GetAddress() => _address;

        public Task<string> SignPaymentAsync(PaymentRequest request)
        {
            // Construct the EIP-712 typed data hash for x402 payment
            var payload = new X402PaymentPayload
            {
                version = "x402-v1",
                from = _address,
                to = request.Recipient,
                amount = request.Amount.ToString(),
                token = request.Token,
                chain = request.Chain,
                nonce = request.Nonce,
                deadline = request.Deadline
            };

            var payloadJson = JsonUtility.ToJson(payload);
            var payloadBytes = Encoding.UTF8.GetBytes(payloadJson);

            // HMAC-SHA256 signing (placeholder for full EIP-712 secp256k1 signing)
            // In production, use Nethereum or a native plugin for proper EVM signing
            using var hmac = new HMACSHA256(_privateKey);
            var signatureBytes = hmac.ComputeHash(payloadBytes);

            var signedPayload = new X402SignedPayload
            {
                payload = payloadJson,
                signature = "0x" + BytesToHex(signatureBytes)
            };

            var result = Convert.ToBase64String(
                Encoding.UTF8.GetBytes(JsonUtility.ToJson(signedPayload))
            );

            return Task.FromResult(result);
        }

        private static byte[] HexToBytes(string hex)
        {
            hex = hex.Replace("0x", "").Replace("0X", "");
            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }

        private static string BytesToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
                sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        [Serializable]
        private class X402PaymentPayload
        {
            public string version;
            public string from;
            public string to;
            public string amount;
            public string token;
            public string chain;
            public string nonce;
            public long deadline;
        }

        [Serializable]
        private class X402SignedPayload
        {
            public string payload;
            public string signature;
        }
    }
}
