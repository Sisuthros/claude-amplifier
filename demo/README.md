# Demo Recording — claude-amplifier 1.4.0

This directory contains everything needed to record the 30-second demo GIF/asciinema for the README and launch posts.

## What the demo shows

1. **The problem** — a fresh terminal asking Claude something Claude has already gotten wrong once
2. **`amplify_preflight`** — Pattern Oracle warns BEFORE the task starts
3. **`amplify_record_claim`** — logging a guess that hasn't been verified
4. **`amplify_verify_claim`** — promoting claim → evidence → confirmed
5. **`amplify_evidence_chain`** — audit trail showing why a lesson is trusted

The whole loop is ~30-45 seconds.

## Tools required

- **asciinema** (record + cast): `pip install asciinema` or `brew install asciinema`
- **agg** (convert .cast → .gif): `cargo install --git https://github.com/asciinema/agg` (or download release binary)
- Optional: **terminalizer** as an alternative if asciinema is awkward on Windows

## How to record

1. Open a fresh terminal (PowerShell on Windows, Terminal on macOS, gnome-terminal on Linux). Resize to **120 columns × 30 rows** for best legibility in the GIF.
2. From this directory, run the prep script to seed a clean demo database:
   ```bash
   node prep-demo-db.mjs
   ```
3. Start asciinema:
   ```bash
   asciinema rec amplifier-demo.cast --cols 120 --rows 30 --idle-time-limit 2
   ```
4. Follow the script in `demo-script.md` — type each command, pause for the output to render, move on.
5. When done, press `Ctrl-D` to stop recording.
6. Render to GIF:
   ```bash
   agg amplifier-demo.cast amplifier-demo.gif --font-size 16 --theme github-dark
   ```
7. Trim to ≤45 seconds and ≤3 MB if you need to upload it to README. Use `gifsicle` or `ffmpeg` if it needs shrinking:
   ```bash
   gifsicle -O3 --lossy=80 -o amplifier-demo-small.gif amplifier-demo.gif
   ```

## Where to use it

- **README.md**: top of the file, right under the tagline, in a `<details>` block or directly
- **Twitter/X thread**: tweet #3 (the "Solution 1" tweet)
- **Reddit posts**: top of the post body
- **Show HN**: in the body, just after the problem statement
- **landing page** (`site/index.html`): hero section right of the install command

## Files

- `demo-script.md` — exact commands + timing
- `prep-demo-db.mjs` — seeds `~/.claude-amplifier-demo.db` with a fixed lesson set so the demo is reproducible
- `cleanup-demo.mjs` — removes the demo DB after recording
