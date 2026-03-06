# AgentWallet SDK — Distribution Plan

> **Goal:** Maximum developer visibility across Web3, AI agent, and general dev ecosystems.  
> **Status:** Already live on npm (`agentwallet-sdk` v2.0.1) and ClawHub (v1.0.0).  
> **Date:** 2026-02-17

---

## Tier 1 — High Impact (Submit This Week)

### 1. Alchemy Dapp Store — Base Ecosystem

- **URL:** <https://www.alchemy.com/dapps/ecosystem/base>
- **Submit:** <https://www.alchemy.com/dapps/submit> (free listing)
- **Category:** Developer Tools → Wallet Infrastructure
- **Why:** Primary discovery for Base developers. 447+ projects listed. Coinbase/Base alignment.
- **Action:** Fill form with logo, description, GitHub link, Base chain tag.

### 2. awesome-web3 (ahmet/awesome-web3)

- **URL:** <https://github.com/ahmet/awesome-web3>
- **Section:** Developer Tools → Wallets or AI Agents
- **Why:** Curated, high-star list. Already lists PolicyLayer (competitor positioning).
- **Action:** Open PR — see `AWESOME_LIST_PR.md`.

### 3. awesome-web3.com

- **URL:** <https://awesome-web3.com/>
- **Submit:** PR to the backing GitHub repo or submit form on site
- **Why:** Lists Chitin, OnchainKit, RainbowKit — our peers. High SEO value.
- **Action:** Submit via their contribution flow.

### 4. Product Hunt Launch

- **URL:** <https://www.producthunt.com/>
- **Why:** Dev audience, AI + crypto crossover crowd. Timely with Coinbase/Stripe news.
- **Action:** Use `PRODUCT_HUNT_DRAFT.md`. Schedule for a Tuesday/Wednesday.

### 5. e2b-dev/awesome-ai-agents

- **URL:** <https://github.com/e2b-dev/awesome-ai-agents>
- **Section:** Open Source → Crypto/Web3 Agents
- **Why:** 10k+ stars. The canonical AI agents list.
- **Action:** Open PR — see `AWESOME_LIST_PR.md`.

---

## Tier 2 — Strong Signal (Submit Within 2 Weeks)

### 6. Rayo.gg (The Dapp List) — Base Ecosystem

- **URL:** <https://rayo.gg/chain/base>
- **Why:** 447 Base projects listed. Discovery for Base-native builders.
- **Action:** Submit project through their listing flow.

### 7. slavakurilyak/awesome-ai-agents

- **URL:** <https://github.com/slavakurilyak/awesome-ai-agents>
- **Why:** 300+ agents listed, actively maintained.
- **Action:** PR to add under "Crypto / Web3 Agents" or "Developer Tools."

### 8. jim-schwoebel/awesome_ai_agents

- **URL:** <https://github.com/jim-schwoebel/awesome_ai_agents>
- **Why:** 1,500+ resources. References AgentsDirectory.
- **Action:** PR to relevant category.

### 9. AI Agents Directory

- **URL:** <https://aiagentsdirectory.com/>
- **Why:** 1.3k+ agents. Marketplace with pricing/feature comparison.
- **Action:** Submit via their "Submit Agent" flow.

### 10. AI Agent Store

- **URL:** <https://aiagentstore.ai/>
- **Why:** AI agent marketplace + directory.
- **Action:** Submit listing.

### 11. aiagents.directory

- **URL:** <https://aiagents.directory/>
- **Why:** Comprehensive AI agents directory.
- **Action:** Submit tool listing.

### 12. AI Agents List

- **URL:** <https://aiagentslist.com/>
- **Why:** 600+ agents, actively updated for 2026.
- **Action:** Submit via their form.

---

## Tier 3 — Ecosystem Depth (Ongoing)

### 13. Base Ecosystem Page (Official)

- **URL:** <https://base.org/ecosystem>
- **Action:** Apply via their ecosystem submission form or reach out to Base DevRel.

### 14. DeepNLP AI Agent Marketplace

- **URL:** <https://www.deepnlp.org/>
- **Why:** 1000+ agents, search portal.
- **Action:** Submit listing.

### 15. kyrolabs/awesome-agents

- **URL:** <https://github.com/kyrolabs/awesome-agents>
- **Action:** PR to add AgentWallet SDK.

### 16. steel-dev/awesome-web-agents

- **URL:** <https://github.com/steel-dev/awesome-web-agents>
- **Action:** PR if web-agent payment fits their scope.

### 17. Jenqyang/Awesome-AI-Agents

- **URL:** <https://github.com/Jenqyang/Awesome-AI-Agents>
- **Action:** PR under developer tools/infrastructure.

### 18. Dev.to / Hashnode Article

- **Action:** Publish "How Coinbase and Stripe Agent Payments Compare (and Why We Built a Non-Custodial Alternative)" — link to SDK.

### 19. X/Twitter Thread

- **Action:** Ship thread: "Coinbase CDP is custodial. Stripe is merchant-side. Here's the third way → AgentWallet." Pin to profile.

---

## Submission Checklist (per listing)

- [ ] Logo (square, 512x512 PNG)
- [ ] One-liner: "Non-custodial wallet SDK for AI agents — on-chain spend limits, x402 payments, Base Mainnet"
- [ ] GitHub URL
- [ ] npm URL: <https://www.npmjs.com/package/agentwallet-sdk>
- [ ] Landing page URL (if deployed)
- [ ] Category tags: AI agents, wallet, web3, Base, ERC-6551, x402
- [ ] Screenshot/diagram of spend limit flow

---

## Key Positioning vs. Competitors

| | AgentWallet | Coinbase CDP | Stripe Agent Toolkit |
|---|---|---|---|
| Custody | **Non-custodial** | Custodial | Merchant-side |
| Limits | On-chain enforced | API rate limits | Confirmation prompts |
| Protocol | x402, ERC-6551 | Proprietary | Proprietary |
| Chain | Base (+ Eth, Arb, Poly) | Base, Ethereum | Fiat + stablecoins |
| License | MIT Open Source | Proprietary | Proprietary |
