---
name: setup
description: Configure Mismatch Auditor API keys and settings
argument-hint: "[groq|openrouter|threshold|status]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
---

# Mismatch Auditor Setup

The user wants to configure the Mismatch Auditor plugin.

## What to do

Based on the user's argument ($ARGUMENTS), do ONE of the following:

### If no argument or "status":
1. Check which API keys are currently set by looking at env vars: `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `OPENROUTER_API_KEY`, and their `CLAUDE_PLUGIN_OPTION_` variants
2. Check the current threshold and log level
3. Report what's configured and what's missing
4. Show a short help:
   - `/mismatch-auditor:setup groq` — set Groq API key
   - `/mismatch-auditor:setup openrouter` — set OpenRouter API key  
   - `/mismatch-auditor:setup threshold 0.65` — change threshold
   - `/mismatch-auditor:setup status` — show current config

### If "groq":
Ask the user to paste their Groq API key. Then explain how to persist it:

**Option 1 — Shell profile (recommended):**
Add to `~/.bashrc` or `~/.zshrc`:
```
export GROQ_API_KEY_1=<their key>
```

**Option 2 — Claude Code settings:**
The user can run `/plugin configure mismatch-auditor` to set it via plugin config (fields are not masked).

### If "openrouter":
Same as groq but for `OPENROUTER_API_KEY`.

### If "threshold":
The second word in $ARGUMENTS is the value. Explain how to set it:
- Env var: `export AUDITOR_THRESHOLD=0.65`
- Or plugin config: `/plugin configure mismatch-auditor`

### General notes:
- At least ONE API key (Groq or OpenRouter) must be set for LLM verification to work
- Without any key, only denylist/allowlist rules work (no LLM check)
- Keys can be set via env vars OR via `/plugin configure mismatch-auditor`
- Groq free tier: 30 req/min. Get a key at https://console.groq.com
- OpenRouter: free models available. Get a key at https://openrouter.ai
