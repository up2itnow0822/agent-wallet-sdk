using System;
using System.Collections.Generic;

namespace AgentWallet.X402
{
    [Serializable]
    public class PaymentRequest
    {
        public string Recipient;
        public decimal Amount;
        public string Token;
        public string Chain;
        public string Nonce;
        public long Deadline;
    }

    [Serializable]
    public class PaymentRequirement
    {
        public string PayTo;
        public decimal MaxAmountRequired;
        public string Token;
        public string Network;
        public string Nonce;
        public long Deadline;
        public string Description;
    }

    [Serializable]
    public class X402ResponseBody
    {
        public PaymentRequirement[] paymentRequirements;
        public string error;
    }

    public class RawResponse
    {
        public int StatusCode;
        public string Body;
        public Dictionary<string, string> Headers;
    }

    public class X402Response
    {
        public int StatusCode;
        public int InitialStatusCode;
        public string Body;
        public Dictionary<string, string> Headers;
        public bool PaymentMade;
        public bool RetryAttempted;
        public decimal PaymentAmount;
        public string PaymentToken;
        public string PaymentRequirementSource;
        public PaymentRecord PaymentRecord;
        public string Error;
    }

    public class PaymentRecord
    {
        public string Url;
        public decimal Amount;
        public string Token;
        public string Chain;
        public string Recipient;
        public DateTime Timestamp;
        public int InitialStatusCode;
        public int RetryStatusCode;
        public string RequirementSource;
        public bool Success;
    }
}
