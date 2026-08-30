# Agent Wallet x402 Unity SDK

x402 HTTP payment protocol for Unity. Give any NPC or AI agent the ability to
pay for APIs, assets, and services with stablecoin micropayments.

## What This Does

When your game agent hits an API that returns HTTP 402 (Payment Required), this
SDK automatically:

1. Parses the x402 payment requirements from the response
2. Signs a USDC payment with the agent's wallet
3. Retries the request with the payment header
4. Tracks spending against configurable session limits

One component. Drag and drop. Your NPCs can now buy things.

## Install

### Unity Package Manager (Git URL)

1. Open Unity > Window > Package Manager
2. Click "+" > Add package from git URL
3. Enter `https://github.com/up2itnow0822/agent-wallet-sdk.git?path=unity-sdk`

### Manual

Clone this repo and copy the `unity-sdk/` folder into your project's `Packages/`
directory.

## Quick Start

```csharp
// Attach X402AgentBehaviour to your NPC GameObject in the Inspector
// Set walletAddress, devPrivateKey (dev only), and spending limits

// Then from any script on the same object:
var agent = GetComponent<X402AgentBehaviour>();
var response = await agent.GetAsync("https://api.example.com/data");

if (response.PaymentMade)
    Debug.Log($"Paid {response.PaymentAmount} USDC");
```

### Programmatic Setup

```csharp
var config = new X402Config
{
    MaxSessionSpend = 5.00m,    // Cap at $5 per session
    MaxSinglePayment = 0.50m,   // No single payment over $0.50
    DefaultChain = "base"
};

var signer = new LocalKeySigner(privateKeyHex, walletAddress);
var client = new X402Client(config, signer);

var response = await client.SendAsync("https://paid-api.example.com/generate");
```

## Custom Signers

Implement `IX402Signer` to connect any wallet backend:

```csharp
public class MyHardwareSigner : IX402Signer
{
    public string GetAddress() => "0x...";

    public async Task<string> SignPaymentAsync(PaymentRequest request)
    {
        // Connect to hardware wallet, custodial API, or MPC service
        return await myBackend.Sign(request);
    }
}
```

## Testing

The package includes Unity EditMode coverage for x402 retry handling and
fail-closed spending caps.

### Docker Runner

Run the local Docker-based test path instead of GitHub CI:

```bash
cd agent-wallet-sdk/unity-sdk

UNITY_EDITOR_IMAGE=unityci/editor:ubuntu-2021.3.0f1-base-3 \
bash scripts/run-editmode-tests-docker.sh
```

After Unity Hub activates a local license, the script auto-detects the standard
license file paths on macOS (`/Library/Application Support/Unity/Unity_lic.ulf`)
and Linux (`~/.local/share/unity3d/Unity/Unity_lic.ulf`). You can still pass
`UNITY_LICENSE_FILE=/absolute/path/to/Unity_lic.ulf` or `UNITY_LICENSE` with
the full license contents if your runner injects the license directly.
Point `UNITY_LICENSE_FILE` at a real `Unity_lic.ulf`, not
`UnityEntitlementLicense.xml`; the Linux 2021.3 editor image will reject the
macOS entitlement XML.

For `Unity Personal`, Unity's supported path is to sign in through Unity Hub
and use `Preferences -> Licenses -> Add -> Get a free personal license` so the
`.ulf` file is created locally. The script writes the test XML and Unity log to
`${TMPDIR%/}/agentwallet-x402-editmode` by default; override that location with
`ARTIFACTS_DIR=/path/to/output`.

## Spending Controls

Every agent has built-in spending limits:

- **MaxSessionSpend** - Total USDC cap per session (default: $1.00)
- **MaxSinglePayment** - Per-request cap (default: $0.10)
- **PaymentHistory** - Full audit trail of every payment made

Payments exceeding limits are rejected before signing. No silent overspend.

## Supported Networks

| Network | Token | Status |
| --- | --- | --- |
| Base | USDC | Live |
| Ethereum | USDC | Live |
| Solana | USDC | Coming soon |

## Architecture

```text
X402AgentBehaviour (MonoBehaviour)
    -> X402Client (core logic)
        -> IX402Signer (pluggable signing)
        -> X402Config (spending limits)
```

The SDK follows the [x402 protocol spec](https://www.x402.org/) by
Coinbase. Any server that returns standard x402 payment requirements in its 402
response will work automatically.

## Requirements

- Unity 2021.3+
- .NET Standard 2.1 or .NET Framework 4.x

## License

MIT - see [LICENSE](../LICENSE)

> *This SDK is part of the [Agent Wallet
> SDK](https://github.com/up2itnow0822/agent-wallet-sdk) - non-custodial crypto
> wallets for AI agents.*
