using System.Threading.Tasks;
using AgentWallet.X402;
using UnityEngine;

/// <summary>
/// Demo: NPC agent pays for a weather API call using x402.
/// Attach this to any GameObject alongside X402AgentBehaviour.
/// </summary>
public class X402Demo : MonoBehaviour
{
    [Header("API Settings")]
    public string apiUrl = "https://api.example.com/weather?city=Austin";

    private X402AgentBehaviour _agent;

    void Start()
    {
        _agent = GetComponent<X402AgentBehaviour>();
        if (_agent == null)
        {
            Debug.LogError("X402Demo requires X402AgentBehaviour on the same GameObject.");
            return;
        }

        // Fire the paid API call
        _ = FetchWeatherAsync();
    }

    async Task FetchWeatherAsync()
    {
        Debug.Log("[Demo] NPC requesting weather data (will pay via x402 if required)...");

        var response = await _agent.GetAsync(apiUrl);

        if (response.RetryAttempted)
        {
            Debug.Log($"[Demo] x402 retry triggered from status {response.InitialStatusCode} using {response.PaymentRequirementSource ?? "unknown"} requirements.");
        }

        if (response.PaymentMade && response.PaymentRecord != null)
        {
            Debug.Log($"[Demo] Paid {response.PaymentAmount} {response.PaymentToken} for API access.");
            Debug.Log($"[Demo] Retry outcome: {response.PaymentRecord.RetryStatusCode}, recipient {response.PaymentRecord.Recipient}, chain {response.PaymentRecord.Chain}.");
        }

        if (response.StatusCode == 200)
        {
            Debug.Log($"[Demo] Weather data received: {response.Body}");
        }
        else
        {
            Debug.LogWarning($"[Demo] Request failed with status {response.StatusCode}: {response.Error ?? response.Body}");
        }

        Debug.Log($"[Demo] Session total spend: {_agent.GetSessionSpend()} USDC");
    }
}
