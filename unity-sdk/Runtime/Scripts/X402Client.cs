using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using UnityEngine;

namespace AgentWallet.X402
{
    /// <summary>
    /// Core x402 client for Unity. Handles HTTP 402 Payment Required responses
    /// by constructing and sending x402-compliant payment headers automatically.
    /// Supports USDC on Base, Ethereum, and Solana.
    /// </summary>
    public class X402Client
    {
        private static readonly Regex PaymentRequirementBodyRegex = new(
            "\"paymentRequirements\"\\s*:\\s*\\[\\s*(\\{.*?\\})",
            RegexOptions.IgnoreCase | RegexOptions.Singleline
        );
        private static readonly Regex DecimalFieldRegex = new(
            "\"{0}\"\\s*:\\s*(?:\"(?<quoted>[^\"]+)\"|(?<raw>-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?))"
        );
        private readonly X402Config _config;
        private readonly IX402Signer _signer;
        private readonly IX402Transport _transport;
        private readonly List<PaymentRecord> _paymentHistory = new();
        private decimal _sessionSpent;

        public decimal SessionSpent => _sessionSpent;
        public IReadOnlyList<PaymentRecord> PaymentHistory => _paymentHistory.AsReadOnly();

        public X402Client(
            X402Config config,
            IX402Signer signer,
            IX402Transport transport = null
        )
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _signer = signer ?? throw new ArgumentNullException(nameof(signer));
            _transport = transport ?? new UnityWebRequestTransport();
        }

        /// <summary>
        /// Send an HTTP request with automatic x402 payment handling.
        /// If the server responds with 402, constructs a payment and retries.
        /// </summary>
        public async Task<X402Response> SendAsync(string url, string method = "GET", string body = null, Dictionary<string, string> headers = null)
        {
            var firstAttempt = await _transport.SendAsync(
                url,
                method,
                body,
                headers,
                _config.RequestTimeoutSeconds
            );

            if (firstAttempt.StatusCode != 402)
            {
                return new X402Response
                {
                    StatusCode = firstAttempt.StatusCode,
                    InitialStatusCode = firstAttempt.StatusCode,
                    Body = firstAttempt.Body,
                    Headers = firstAttempt.Headers,
                    PaymentMade = false,
                    RetryAttempted = false
                };
            }

            // Parse x402 payment requirements from 402 response
            var paymentReq = ParsePaymentRequirement(
                firstAttempt,
                out var requirementSource
            );
            if (paymentReq == null)
            {
                Debug.LogWarning("[x402] Server returned 402 but no valid x402 payment requirements found.");
                return new X402Response
                {
                    StatusCode = 402,
                    InitialStatusCode = firstAttempt.StatusCode,
                    Body = firstAttempt.Body,
                    Headers = firstAttempt.Headers,
                    PaymentMade = false,
                    RetryAttempted = false,
                    Error = "No valid x402 payment requirement in 402 response"
                };
            }

            // Fail closed when the quoted payment exceeds configured limits.
            if (!TryAuthorizePayment(paymentReq.MaxAmountRequired, out var limitError))
            {
                return new X402Response
                {
                    StatusCode = 402,
                    InitialStatusCode = firstAttempt.StatusCode,
                    Body = "Payment rejected by local policy",
                    PaymentMade = false,
                    RetryAttempted = false,
                    PaymentRequirementSource = requirementSource,
                    Error = limitError
                };
            }

            // Sign the payment
            var paymentPayload = await _signer.SignPaymentAsync(new PaymentRequest
            {
                Recipient = paymentReq.PayTo,
                Amount = paymentReq.MaxAmountRequired,
                Token = paymentReq.Token,
                Chain = paymentReq.Network,
                Nonce = paymentReq.Nonce,
                Deadline = paymentReq.Deadline
            });

            // Retry with payment header
            var paymentHeaders = new Dictionary<string, string>(headers ?? new Dictionary<string, string>())
            {
                ["X-PAYMENT"] = paymentPayload,
                ["X-PAYMENT-VERSION"] = "x402-v1"
            };

            var paidResponse = await _transport.SendAsync(
                url,
                method,
                body,
                paymentHeaders,
                _config.RequestTimeoutSeconds
            );

            var record = new PaymentRecord
            {
                Url = url,
                Amount = paymentReq.MaxAmountRequired,
                Token = paymentReq.Token,
                Chain = paymentReq.Network,
                Recipient = paymentReq.PayTo,
                Timestamp = DateTime.UtcNow,
                InitialStatusCode = firstAttempt.StatusCode,
                RetryStatusCode = paidResponse.StatusCode,
                RequirementSource = requirementSource,
                Success = paidResponse.StatusCode >= 200 && paidResponse.StatusCode < 300
            };
            _paymentHistory.Add(record);
            _sessionSpent += paymentReq.MaxAmountRequired;

            Debug.Log($"[x402] Payment sent: {paymentReq.MaxAmountRequired} {paymentReq.Token} to {paymentReq.PayTo} on {paymentReq.Network}");

            return new X402Response
            {
                StatusCode = paidResponse.StatusCode,
                InitialStatusCode = firstAttempt.StatusCode,
                Body = paidResponse.Body,
                Headers = paidResponse.Headers,
                PaymentMade = true,
                RetryAttempted = true,
                PaymentAmount = paymentReq.MaxAmountRequired,
                PaymentToken = paymentReq.Token,
                PaymentRequirementSource = requirementSource,
                PaymentRecord = record
            };
        }

        private bool TryAuthorizePayment(decimal amount, out string rejectionReason)
        {
            rejectionReason = null;

            if (_config.MaxSinglePayment > 0 && amount > _config.MaxSinglePayment)
            {
                rejectionReason = $"Payment of {amount} exceeds single payment limit of {_config.MaxSinglePayment}";
                return false;
            }

            if (_config.MaxSessionSpend > 0 && (_sessionSpent + amount) > _config.MaxSessionSpend)
            {
                rejectionReason = $"Payment of {amount} would exceed session limit of {_config.MaxSessionSpend}";
                return false;
            }

            return true;
        }

        private PaymentRequirement ParsePaymentRequirement(
            RawResponse response,
            out string requirementSource
        )
        {
            requirementSource = null;

            // x402 spec: payment requirements in X-PAYMENT-REQUIREMENTS header (JSON)
            if (response.Headers != null && response.Headers.TryGetValue("X-PAYMENT-REQUIREMENTS", out var reqJson))
            {
                try
                {
                    requirementSource = "header";
                    return ParsePaymentRequirementJson(reqJson);
                }
                catch (Exception e)
                {
                    requirementSource = null;
                    Debug.LogWarning($"[x402] Failed to parse payment requirements header: {e.Message}");
                }
            }

            // Fallback: try parsing from response body
            if (!string.IsNullOrEmpty(response.Body))
            {
                try
                {
                    if (TryExtractFirstRequirementJson(response.Body, out var bodyReqJson))
                    {
                        requirementSource = "body";
                        return ParsePaymentRequirementJson(bodyReqJson);
                    }
                }
                catch { }
            }

            return null;
        }

        /// <summary>
        /// Reset session spending tracker.
        /// </summary>
        public void ResetSession()
        {
            _sessionSpent = 0;
            _paymentHistory.Clear();
        }

        private static PaymentRequirement ParsePaymentRequirementJson(string json)
        {
            var requirement = JsonUtility.FromJson<PaymentRequirement>(json);
            if (requirement == null)
            {
                return null;
            }

            // Unity's JsonUtility leaves decimal fields at 0, so recover quoted
            // or numeric amounts directly from the raw JSON payload.
            if (TryParseDecimalField(json, "MaxAmountRequired", out var amount))
            {
                requirement.MaxAmountRequired = amount;
            }

            return requirement;
        }

        private static bool TryExtractFirstRequirementJson(
            string responseBody,
            out string requirementJson
        )
        {
            var match = PaymentRequirementBodyRegex.Match(responseBody);
            if (match.Success)
            {
                requirementJson = match.Groups[1].Value;
                return true;
            }

            requirementJson = null;
            return false;
        }

        private static bool TryParseDecimalField(
            string json,
            string fieldName,
            out decimal value
        )
        {
            var fieldRegex = new Regex(
                string.Format(CultureInfo.InvariantCulture, DecimalFieldRegex.ToString(), fieldName),
                RegexOptions.IgnoreCase | RegexOptions.Singleline
            );
            var match = fieldRegex.Match(json);
            if (match.Success)
            {
                var rawValue = match.Groups["quoted"].Success
                    ? match.Groups["quoted"].Value
                    : match.Groups["raw"].Value;
                return decimal.TryParse(
                    rawValue,
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out value
                );
            }

            value = 0m;
            return false;
        }
    }
}
