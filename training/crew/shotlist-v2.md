# Crew walkthrough — shot list v2 (director spec)

Re-cut of `training-crew-v1.mp4`. Same pipeline (Playwright → ElevenLabs →
Remotion), three directed changes. The manual (`components/manual/crew-manual.tsx`,
**9 parts**) is the source of truth — every part gets a video section, same order.

## Director's note — the decisions that matter most for this cut

1. **Sharpness is a capture decision.** v1 filmed the phone at 390×844 and the
   Remotion phone-frame then showed ~416 px of it, so the source carried barely
   one screen-pixel per frame-pixel and went soft under any player upscaling.
   Playwright's `recordVideo` never upscales (proven: v1 webm = 390×844 with
   `deviceScaleFactor:2` — DSF does not add video pixels). The only lever is a
   **larger CSS viewport that still renders the phone layout.** Both crew pages
   use `mx-auto max-w-2xl` and only break to two columns at `sm` (640px), so a
   phone-proportioned **585×1266** viewport (exactly 1.5× of 390×844, aspect
   0.462) stays single-column phone AND gives 2.25× the source pixels. The
   phone frame then **downscales** 585→~434 → crisp master.
2. **Pauses before every tap.** `tap()` now holds ~1.1s with the red target
   ring sat ON the control (readable) BEFORE the click, and ~0.7s AFTER so the
   result lands — never a cut on the action frame. Each section also carries a
   ~1.0s TAIL beyond the narration so the last action registers before the cut.
3. **The missed section is restored → 9 parts.** v1 had ONE "During the move"
   section that wrongly framed the red camera as damage-recording. Split to
   mirror the manual: Part 5 = a problem → **Crew notes & photos (private)**;
   Part 6 = a good moment → the **red camera**, filmed with the **consent card
   showing** (seed leaves `media_consent` unset) and the "Customer's OK'd it"
   tap. Old parts 6/7/8 renumber to 7/8/9.

Pointing = the on-footage red target ring (baked into the captured pixels, so
always sharp and correctly placed) + the animated ring on each slide glyph.

## Spine + budget (≤ 3:30 total)

title (4s) → process slide "the way we work" (intro audio) → 9 sections (each:
2.6s slide beat → footage-in-phone, narration + burned captions, +1.0s tail) →
recap slide → outro (v-sha stamp). Section length = narration + tail, so total
tracks the ~500-word script (~3:10 projected).

## Coverage map — 9 manual parts → 9 sections

| Manual part | Section | Tap target(s) / beat | Zoom / point | Demo STATE |
|---|---|---|---|---|
| 1 Start your day | part-1 | week strip + day list; point a job card | red ring on card | any |
| 2 Open a job | part-2 | tap job card → scroll to item list ("Not moving" pill) | ring on card, hold on pill | SIGNED (no banner) |
| 3 Get there | part-3 | point **Directions**, then **Call** in cab bar | ring on Directions | SIGNED |
| 4 When you arrive | part-4 | yellow banner → **Collect signature now** → tick + sign → cancel | ring on banner button | **UNSIGNED** (banner shows) |
| 5 A problem? Write it down | part-5 (NEW map) | Crew notes & photos: type note, point **Add photos**, tap **Save note** | ring on Save note | SIGNED |
| 6 Get it on camera | part-6 (NEW) | red camera FAB → **consent card** → tap **Customer's OK'd it**; show Photo/Video/Voice | ring on consent button | SIGNED + **media_consent UNSET** |
| 7 Finishing the job | part-7 (was 6) | **Complete job** → exceptions + sign → cancel | ring on Complete job | SIGNED |
| 8 The job sheet | part-8 (was 7) | point/tap **Job sheet** | ring on Job sheet | SIGNED |
| 9 Set up your phone | part-9 (was 8) | scroll to **Your device**, point install/alerts/passkey, tap **User manual** | ring on manual row | any |

No manual part is uncovered. Money/price never appears (crew-price-free
invariant holds — same as v1).

## Per-section pacing (the pause rule, in the footage)

- Every `tap()`: scroll-in → 0.5s settle → red ring appears on target → **1.1s
  hold** (button readable) → ripple → click → **0.7s post-hold**.
- Dense sections (4/5/6/7) front-load actions inside the narration window; the
  narration for each is long enough (≥ the action sequence) so nothing is cut.
- `point()` (new): shows the ring on a control WITHOUT clicking — used for
  Add photos / Job sheet / Directions / device rows where a real click would
  open a native picker or download and add nothing on screen.

## Retina capture note

`record.ts`: `viewport {585,1266}`, `recordVideo.size {585,1266}`,
`deviceScaleFactor 3`. Verify by eye on extracted frames that UI text is crisp
(the critic's rubric-1 gate). PhoneFrame aspect (390/844) already matches
585/1266 so `objectFit: cover` does not crop.
