# Marley Ops — training-video pipeline

Regenerable training videos built from **real screen recordings + ElevenLabs
narration + Remotion**. Pilot: the crew walkthrough (`crew/`). This folder is a
**standalone project** — its own `package.json`, NOT part of the Next.js app,
and excluded from the app's tsconfig, eslint, and the Docker/CI image
(`.dockerignore`). Nothing here ships in `ops.marleymoves.co.uk`.

Built for the `role-training-materials` skill (Part 2 recipe).

## What it produces

`crew/out/training-crew-v1.mp4` — a ~2m36s, 1080p30 narrated crew walkthrough:
brand title card → "how we work" process slide → the 8 manual parts (each a
slide beat then the real app filmed inside a phone frame, with word-synced
burned captions) → recap → outro stamped `Marley Ops · v <sha>`.

## Layout

```
training/
  package.json          orchestration scripts (seed / tts / record / render)
  crew/
    narration.md        ~440-word script, one ## block per section  (SOURCE)
    demo.config.mjs      the fake demo customer + crew login (local only)
    seed-demo.mjs        seeds/cleans the LOCAL demo dataset to film against
    tts.mjs              narration.md -> ElevenLabs George -> audio/ + timings
    record.ts            Playwright -> footage/*.webm (phone viewport)
    audio/               <id>.mp3 + timeline.json   (generated, gitignored)
    footage/             <id>.webm                  (generated, gitignored)
    out/                 the rendered mp4           (generated, gitignored)
  video/                 Remotion project (assembly)
    src/                 compositions (committed)
    public/              audio + footage(mp4) + brand assets (generated copies)
```

Only the **code + narration** is committed. All media artifacts regenerate.

## Prerequisites

- Local Supabase for marley-ops running in Docker (`supabase_db_marley-ops`).
- App dev seeds run once so the crew login + staff + van exist:
  `node --env-file=.env.local scripts/seed-dev.mjs` and
  `node --env-file=.env.local scripts/seed-dev-crew.mjs` (from the repo root).
- `ELEVENLABS_API_KEY` in env or `F:\My Drive\workspace\credentials.env`.
- A local dev server bound on the allocated port (see below).
- `npm install` in both `training/` and `training/video/`.

## Regenerate the whole video (after a crew-UI change)

From `training/`, with a dev server already running on the port you filmed at:

```bash
# 0. one-time deps
npm install && npm --prefix video install

# 1. allocate a port + start the dev server (repo root)
PORT=$(pwsh -c '& "O:\RBS-OS\scripts\port-alloc.ps1" alloc -Project marley-ops -App training -Stack next -Quiet')
( cd .. && npx next dev -H 0.0.0.0 -p $PORT )   # leave running

# 2. seed the local demo dataset, generate narration, film, assemble
node --env-file=../.env.local crew/seed-demo.mjs
node crew/tts.mjs                                  # ElevenLabs (skips unchanged)
BASE_URL=http://localhost:$PORT npx tsx crew/record.ts
npm --prefix video run render                      # sync assets + render (stamps HEAD sha)

# 3. clean up the local demo rows + release the port
node --env-file=../.env.local crew/seed-demo.mjs --cleanup
pwsh -c '& "O:\RBS-OS\scripts\port-alloc.ps1" release -Port '"$PORT"
```

The one-command convenience wrapper (assumes a dev server is up + `BASE_URL`
set) is `npm run crew:all`. Output lands at `crew/out/training-crew-v1.mp4`.

### The single render command (after footage/audio exist)

```bash
cd training/video && npm run render     # sync-assets.mjs then render.mjs; stamps the HEAD sha
```

## Hard rules (baked into the scripts)

- **Zero production writes.** `demo.config.mjs` + every seed/record entry point
  refuse any non-local Supabase/app URL. Footage is filmed on local dev only.
- **No email/SMS.** Filming never submits sign-off or contract dialogs (they are
  cancelled); `COMMS_DRYRUN=true` in the worktree `.env.local`.
- **Video body is REAL app footage.** Generated imagery only on the brand cards.
- **Price-free** — crew surfaces carry no money by construction; the video
  inherits that.

## Voice

ElevenLabs **George** (`JBFqnCBsd6RMkjVDRZzb`), model `eleven_multilingual_v2`
(Peter's pick for Marley, 2026-07-16). Change the voice in `crew/tts.mjs`.
