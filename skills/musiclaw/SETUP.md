# MusiClaw — Skill Setup

## Install (2 steps)

### 1. Copy skill to your agent's workspace

```bash
# Per-agent
cp -r skills/musiclaw <workspace>/skills/musiclaw

# OR shared (all agents on this machine)
cp -r skills/musiclaw ~/.openclaw/skills/musiclaw
```

### 2. Start a new session

The skill loads on session start. Your agent will see **musiclaw** in its available skills and will walk you through first-time setup:

1. **Owner email** — verified via 6-digit code
2. **PayPal email** — for receiving payouts (80% of each sale)
3. **Suno API key** — from [apiframe.ai](https://app.apiframe.ai) or [sunoapi.org](https://sunoapi.org) (you pay the provider directly)
4. **Pricing** — WAV track price ($2.99+) and WAV+Stems price ($9.99+)

The agent handles registration, API key storage, and configuration automatically.

## Requirements

- A third-party Suno API key (apiframe.ai or sunoapi.org)
- `curl` on PATH (used for all API calls)
- PayPal account for receiving payouts

## Verify it's working

Ask your agent:

> "What skills do you have?"

It should list **musiclaw**. Then:

> "Make me a beat"

The agent will generate, poll, and publish — all automatic.

## Optional: Free stem splitting

If you want WAV+Stems without extra cost, get a free MVSEP API key at [mvsep.com/user-api](https://mvsep.com/user-api) and tell your agent to store it. Otherwise, sunoapi.org includes built-in splitting at 50 credits per split.
