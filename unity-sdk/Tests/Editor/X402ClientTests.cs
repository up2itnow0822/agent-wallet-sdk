using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using NUnit.Framework;

namespace AgentWallet.X402.Tests.Editor
{
    public class X402ClientTests
    {
        [Test]
        public async Task RejectsPaymentAboveSingleLimitWithoutSigningOrRetrying()
        {
            var transport = new ScriptedTransport(
                new RawResponse
                {
                    StatusCode = 402,
                    Headers = new Dictionary<string, string>
                    {
                        ["X-PAYMENT-REQUIREMENTS"] = HeaderRequirementJson(0.25m)
                    }
                }
            );
            var signer = new RecordingSigner();
            var client = new X402Client(
                new X402Config
                {
                    MaxSinglePayment = 0.10m,
                    MaxSessionSpend = 1.00m
                },
                signer,
                transport
            );

            var response = await client.SendAsync("https://paid.example/catalog");

            Assert.That(response.StatusCode, Is.EqualTo(402));
            Assert.That(response.InitialStatusCode, Is.EqualTo(402));
            Assert.That(response.PaymentMade, Is.False);
            Assert.That(response.RetryAttempted, Is.False);
            Assert.That(
                response.PaymentRequirementSource,
                Is.EqualTo("header")
            );
            Assert.That(
                response.Error,
                Does.Contain("single payment limit")
            );
            Assert.That(client.SessionSpent, Is.EqualTo(0m));
            Assert.That(client.PaymentHistory, Has.Count.EqualTo(0));
            Assert.That(signer.CallCount, Is.EqualTo(0));
            Assert.That(transport.Requests, Has.Count.EqualTo(1));
        }

        [Test]
        public async Task RetriesPaidRequestAndRecordsPaymentMetadata()
        {
            var transport = new ScriptedTransport(
                new RawResponse
                {
                    StatusCode = 402,
                    Headers = new Dictionary<string, string>
                    {
                        ["X-PAYMENT-REQUIREMENTS"] = HeaderRequirementJson(0.05m)
                    }
                },
                new RawResponse
                {
                    StatusCode = 200,
                    Body = "{\"ok\":true}"
                }
            );
            var signer = new RecordingSigner("signed-payment");
            var client = new X402Client(
                new X402Config
                {
                    MaxSinglePayment = 0.10m,
                    MaxSessionSpend = 1.00m
                },
                signer,
                transport
            );

            var response = await client.SendAsync(
                "https://paid.example/generate",
                "POST",
                "{\"prompt\":\"hello\"}",
                new Dictionary<string, string>
                {
                    ["X-TRACE-ID"] = "trace-123"
                }
            );

            Assert.That(response.StatusCode, Is.EqualTo(200));
            Assert.That(response.InitialStatusCode, Is.EqualTo(402));
            Assert.That(response.PaymentMade, Is.True);
            Assert.That(response.RetryAttempted, Is.True);
            Assert.That(response.PaymentAmount, Is.EqualTo(0.05m));
            Assert.That(response.PaymentToken, Is.EqualTo("USDC"));
            Assert.That(
                response.PaymentRequirementSource,
                Is.EqualTo("header")
            );
            Assert.That(response.PaymentRecord, Is.Not.Null);
            Assert.That(response.PaymentRecord.InitialStatusCode, Is.EqualTo(402));
            Assert.That(response.PaymentRecord.RetryStatusCode, Is.EqualTo(200));
            Assert.That(
                response.PaymentRecord.RequirementSource,
                Is.EqualTo("header")
            );
            Assert.That(client.SessionSpent, Is.EqualTo(0.05m));
            Assert.That(client.PaymentHistory, Has.Count.EqualTo(1));
            Assert.That(signer.CallCount, Is.EqualTo(1));
            Assert.That(signer.LastRequest.Recipient, Is.EqualTo("0xmerchant"));
            Assert.That(transport.Requests, Has.Count.EqualTo(2));
            Assert.That(
                transport.Requests[1].Headers["X-PAYMENT"],
                Is.EqualTo("signed-payment")
            );
            Assert.That(
                transport.Requests[1].Headers["X-PAYMENT-VERSION"],
                Is.EqualTo("x402-v1")
            );
            Assert.That(
                transport.Requests[1].Headers["X-TRACE-ID"],
                Is.EqualTo("trace-123")
            );
        }

        [Test]
        public async Task FallsBackToBodyRequirementsWhenHeaderMissing()
        {
            var transport = new ScriptedTransport(
                new RawResponse
                {
                    StatusCode = 402,
                    Body = BodyRequirementJson(0.04m)
                },
                new RawResponse
                {
                    StatusCode = 204
                }
            );
            var signer = new RecordingSigner();
            var client = new X402Client(
                new X402Config
                {
                    MaxSinglePayment = 0.10m,
                    MaxSessionSpend = 1.00m
                },
                signer,
                transport
            );

            var response = await client.SendAsync("https://paid.example/body");

            Assert.That(response.StatusCode, Is.EqualTo(204));
            Assert.That(response.PaymentMade, Is.True);
            Assert.That(
                response.PaymentRequirementSource,
                Is.EqualTo("body")
            );
            Assert.That(
                response.PaymentRecord.RequirementSource,
                Is.EqualTo("body")
            );
            Assert.That(signer.LastRequest.Amount, Is.EqualTo(0.04m));
        }

        [Test]
        public async Task RejectsPaymentWhenSessionCapWouldBeExceeded()
        {
            var transport = new ScriptedTransport(
                new RawResponse
                {
                    StatusCode = 402,
                    Headers = new Dictionary<string, string>
                    {
                        ["X-PAYMENT-REQUIREMENTS"] = HeaderRequirementJson(0.15m)
                    }
                },
                new RawResponse
                {
                    StatusCode = 200
                },
                new RawResponse
                {
                    StatusCode = 402,
                    Headers = new Dictionary<string, string>
                    {
                        ["X-PAYMENT-REQUIREMENTS"] = HeaderRequirementJson(0.20m)
                    }
                }
            );
            var signer = new RecordingSigner();
            var client = new X402Client(
                new X402Config
                {
                    MaxSinglePayment = 0.25m,
                    MaxSessionSpend = 0.30m
                },
                signer,
                transport
            );

            var firstResponse = await client.SendAsync("https://paid.example/one");
            var secondResponse = await client.SendAsync("https://paid.example/two");

            Assert.That(firstResponse.StatusCode, Is.EqualTo(200));
            Assert.That(secondResponse.StatusCode, Is.EqualTo(402));
            Assert.That(secondResponse.RetryAttempted, Is.False);
            Assert.That(
                secondResponse.Error,
                Does.Contain("session limit")
            );
            Assert.That(client.SessionSpent, Is.EqualTo(0.15m));
            Assert.That(client.PaymentHistory, Has.Count.EqualTo(1));
            Assert.That(signer.CallCount, Is.EqualTo(1));
            Assert.That(transport.Requests, Has.Count.EqualTo(3));
        }

        private static string HeaderRequirementJson(decimal amount)
        {
            return "{"
                + "\"PayTo\":\"0xmerchant\","
                + "\"MaxAmountRequired\":"
                + amount.ToString(CultureInfo.InvariantCulture)
                + ","
                + "\"Token\":\"USDC\","
                + "\"Network\":\"base\","
                + "\"Nonce\":\"quote-123\","
                + "\"Deadline\":1735689600,"
                + "\"Description\":\"premium asset\""
                + "}";
        }

        private static string BodyRequirementJson(decimal amount)
        {
            return "{"
                + "\"paymentRequirements\":["
                + HeaderRequirementJson(amount)
                + "],"
                + "\"error\":\"payment required\""
                + "}";
        }

        private sealed class RecordingSigner : IX402Signer
        {
            private readonly string _responsePayload;

            public RecordingSigner(string responsePayload = "signed-payload")
            {
                _responsePayload = responsePayload;
            }

            public int CallCount { get; private set; }

            public PaymentRequest LastRequest { get; private set; }

            public string GetAddress() => "0xtester";

            public Task<string> SignPaymentAsync(PaymentRequest request)
            {
                CallCount++;
                LastRequest = request;
                return Task.FromResult(_responsePayload);
            }
        }

        private sealed class ScriptedTransport : IX402Transport
        {
            private readonly Queue<RawResponse> _responses;

            public ScriptedTransport(params RawResponse[] responses)
            {
                _responses = new Queue<RawResponse>(responses);
            }

            public List<RequestRecord> Requests { get; } = new();

            public Task<RawResponse> SendAsync(
                string url,
                string method,
                string body,
                Dictionary<string, string> headers,
                int timeoutSeconds
            )
            {
                Requests.Add(new RequestRecord
                {
                    Url = url,
                    Method = method,
                    Body = body,
                    TimeoutSeconds = timeoutSeconds,
                    Headers = headers == null
                        ? null
                        : new Dictionary<string, string>(headers)
                });

                Assert.That(
                    _responses.Count,
                    Is.GreaterThan(0),
                    "Test transport ran out of scripted responses."
                );

                return Task.FromResult(_responses.Dequeue());
            }
        }

        public sealed class RequestRecord
        {
            public string Url;
            public string Method;
            public string Body;
            public int TimeoutSeconds;
            public Dictionary<string, string> Headers;
        }
    }
}
