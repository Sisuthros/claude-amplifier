# Demo Script — exact commands to type

> Target: 30-45 second GIF. Pause ~1s between commands, ~2s after big outputs.

## Setup (do this BEFORE starting asciinema)

```bash
node demo/prep-demo-db.mjs
# This seeds ~/.claude-amplifier-demo.db with three confirmed lessons:
#   - "Avoid model names containing 'openai/' on ZeptoClaw" (confirmed, freq 3)
#   - "Heartbeat needs TPM >= 30k" (confirmed, freq 2)
#   - "Read NIM /v1/models before configuring fallback chains" (confirmed, freq 5)
# Sets CLAUDE_AMPLIFIER_DB env var so all commands hit the demo db.
```

Then start asciinema:
```bash
asciinema rec amplifier-demo.cast --cols 120 --rows 30 --idle-time-limit 2
```

## The recording script — type these in order

### Beat 1 — show the problem (~5 seconds)

```bash
clear
echo "# Configuring a new model on ZeptoClaw. Was this safe last time...?"
```

### Beat 2 — preflight risk check (~10 seconds)

```bash
claude-amplifier preflight --project demo --task "Configure NIM endpoint with openai/gpt-oss-120b"
```

Expected output (already prepared in the demo DB):

```
🟠 HIGH RISK  score 4.20  evidence: STRONG

Matched patterns (3):
  • [confirmed] Avoid model names containing 'openai/' on ZeptoClaw
    seen 3× across 2 projects, severity: critical
  • [confirmed] Read NIM /v1/models before configuring fallback chains
    seen 5× across 3 projects, severity: high
  • [confirmed] Heartbeat needs TPM >= 30k
    seen 2×, severity: high

Suggested approach: Read docs/zeptoclaw-config-gotchas.md before
choosing the model string. The 'openai/' substring is parsed as the
openai provider at startup but routed as nvidia at runtime — every
heartbeat returns "Invalid API Key".

Try: nvidia/gpt-oss-120b  OR  moonshotai/kimi-k2.6
```

### Beat 3 — log an unverified claim (~5 seconds)

```bash
claude-amplifier record-claim --project demo \
  --title "Switching heartbeat model fixed the rate-limit storm" \
  --type insight
```

Expected:
```
✓ Recorded as claim #17 (confidence 0.5)
```

### Beat 4 — promote with evidence (~8 seconds)

```bash
claude-amplifier verify-claim --id 17 \
  --evidence-type build_passed \
  --evidence-link "https://github.com/example/repo/actions/runs/12345"
```

Expected:
```
✓ #17 promoted: claim → evidence (confidence 0.7)
```

```bash
claude-amplifier verify-claim --id 17 \
  --evidence-type user_confirmation \
  --notes "Confirmed by Ville — no rate limits for 24h"
```

Expected:
```
✓ #17 promoted: evidence → confirmed (confidence 1.0)
```

### Beat 5 — show the audit trail (~5 seconds)

```bash
claude-amplifier evidence-chain --id 17
```

Expected:
```
Lesson #17 — "Switching heartbeat model fixed the rate-limit storm"
  Status: confirmed (confidence 1.0)

  ├─ Recorded as claim    [2026-05-21 19:30]  confidence 0.5
  ├─ Evidence attached    [2026-05-21 19:31]  build_passed
  │  └─ https://github.com/example/repo/actions/runs/12345
  └─ Confirmed by user    [2026-05-22 09:14]  +24h verified
```

### Beat 6 — close (~2 seconds)

```bash
echo ""
echo "✓ claim → evidence → confirmed. No more guesses treated as facts."
```

## Stop recording

Press `Ctrl-D` to stop. Asciinema saves to `amplifier-demo.cast`.

## Cleanup

```bash
node demo/cleanup-demo.mjs
# Removes ~/.claude-amplifier-demo.db
```

## Notes on pacing

- Don't type too fast — viewers need to read the outputs, not just see flashes
- The HIGH RISK box is the moment. Pause ~2s on it
- The final `evidence-chain` ASCII tree is the "ah-ha" moment. Pause ~2s
- Total target: 30-45 seconds. Trim with `agg --speed 1.3` if too long
