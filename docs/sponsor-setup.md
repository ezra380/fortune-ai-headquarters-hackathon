# Meterless H-MEM and NVIDIA Nemotron setup

## Status

Executable integration added in scripts/sponsor-demo.mjs. Five adapter tests passed in the development environment using Node 24.22.1. An offline run against the actual Meterless reference saved mem-1; a second process retrieved mem-1 before saving mem-2. The smoke fixture included one overdue open ticket and one resolved ticket; only demo-t001 was flagged. Nemotron HTTP handling was tested with a mocked response, not a live NVIDIA key. No installation has been performed on Ezra's PC. Zetaris is not called by this runner yet; it reads synthetic JSON locally. README and architecture describe the larger planned platform.

## 1. Open the isolated repository in Ubuntu

Use Node 24 LTS for these commands. The upstream TypeScript uses constructor parameter properties and needs --experimental-transform-types; the experimental warning is expected. Run node --version first. This does not use your ChatGPT or Claude subscription for model inference.

Clone the private repository using your existing GitHub authentication, then select this branch:

```bash
cd ~
git clone --branch integrate-meterless-nemotron https://github.com/ezra380/fortune-ai-headquarters-hackathon.git
cd fortune-ai-headquarters-hackathon
node --version
```

If the folder already exists, use it rather than cloning over it. Inspect git status before switching branches or pulling; preserve other work.

## 2. Install the pinned Meterless reference

This is open-source local memory, not a hosted Meterless account or model router. There are no runtime npm dependencies in this reference. Its persistence is single-process JSON with an audit ledger, suitable for this demo, not production concurrent storage.

```bash
mkdir -p .local
git clone --no-checkout https://github.com/Meterless/Meterless.git .local/meterless
git -C .local/meterless checkout --detach 1742dec56a66e58eef9dda2d2b865823758ca8cd
node --test scripts/sponsor-demo.test.mjs
node --experimental-transform-types scripts/sponsor-demo.mjs --offline
node --experimental-transform-types scripts/sponsor-demo.mjs --offline
```

Run these sequentially. If .local/meterless already exists, inspect it instead of cloning again. On a clean memory directory, the second run should have priorMemoryCount greater than zero and cite the first run's memory ID. Offline analysis is a deterministic rule fixture and is explicitly labeled NOT-NEMOTRON. Threshold 0.1 is a demo recall setting; it is not the upstream production recommendation. Offline memories remain tagged offline-rule and may be included as historical context in later live runs.

## 3. Configure NVIDIA credentials locally

Open the official NVIDIA model page and use its offered account/API-key flow. Model availability, quotas, pricing, and account eligibility must be checked there. Do not paste your key into chat, commit it, or reuse a production credential.

Official model page: https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b

Create a local .env.local with your editor, preserving an existing file if present:

```dotenv
NEMOTRON_API_KEY=your_key_here
NEMOTRON_MODEL=nvidia/nemotron-3-nano-30b-a3b
```

Then run:

```bash
chmod 600 .env.local
node --env-file=.env.local --experimental-transform-types scripts/sponsor-demo.mjs --live
```

The CLI sends only the synthetic ticket/conversation fixture and its local demo memories to NVIDIA's fixed HTTPS endpoint. It does not send real customers, contact external recipients, or modify Zetaris. A successful live receipt names the actual requested model and includes validated evidence IDs. A missing key, HTTP failure, malformed JSON, unknown evidence ID, or truncated response fails explicitly with no model fallback. A 202 pending response is not polled in this initial adapter; it fails explicitly. Configure a different available NVIDIA Nemotron model through NEMOTRON_MODEL if the documented default is unavailable to the account.

## Local outputs and limits

.local/hmem-service-demo stores Meterless state and ledger. .local/runs stores run receipts. Both are ignored by Git. They contain synthetic findings and must stay demo-only. Do not run multiple writers. This is a CLI milestone: the existing TypeScript adapter contracts, Zetaris adapter, dashboard, authenticated approvals, and Supabase audit integration remain future work. actionStatus=draft is a receipt label, not an implemented approval system. Validation confirms cited IDs exist; it does not prove every model statement is true. Review results before presenting the demo.

## Verified official sources

- Meterless reference code and upstream license: https://github.com/Meterless/Meterless/tree/1742dec56a66e58eef9dda2d2b865823758ca8cd/engines/hmem/reference
- Meterless H-MEM guide: https://github.com/Meterless/Meterless/blob/main/engines/hmem/HOW_TO_USE_H-MEM.md
- NVIDIA request contract: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer

The upstream Meterless reference is Apache-2.0 and describes itself as a minimal reference, not a production library. Its checkout and license remain intact under .local. No upstream code is redistributed in this commit. Hackathon sponsor eligibility for using this specific engine is not confirmed by this implementation.
