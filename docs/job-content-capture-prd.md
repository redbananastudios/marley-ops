# Job Content Capture — PRD (v0.9)

**Status: DRAFT for Peter's review (2026-07-16).** Deep-planning output per Peter's
brief: crew/estimators capture photos, short videos and voice notes on jobs from
their phones, transcripts are generated, and everything centralises to the Marley
Google Drive hub so the EXISTING content machine (GBP + Facebook agents in RBS-OS)
turns it into posts. "The UI would need to be very slick." Open questions in §10.

---

## 1. Why (and why it will work here)

The marketing agents already write and publish posts — their scarcest input is
**authentic material**: real crews, real vans, real staircases, real "we got the
piano out" moments. The people standing next to that material all day already
carry the tool (their phone, logged into Marley Ops on the job page).

The category reference is **CompanyCam** (contractor photo capture, the tool crews
actually use). Its three lessons, distilled:

1. **Camera-first, zero filing.** The killer feature isn't the camera — it's that a
   photo files itself to the right project with no decisions. Every added tap
   between "worth a photo" and "captured" halves the volume you get.
2. **Capture now, organise never (or later).** Tagging is optional and after the
   fact; an untagged photo is still worth 90% of a tagged one.
3. **The feed makes it social.** Crews capture more when the office visibly sees
   and uses what they shoot.

From consumer apps: **WhatsApp voice notes** (hold-to-record, slide-up to lock for
hands-free, instant playback) are the ergonomic bar for audio; **BeReal/Snapchat**
prove that removing choices (no filters, no editing) *increases* capture.

Our advantage over CompanyCam: the crew is already ON the job's page in the PWA —
so auto-attachment is free (no GPS matching needed), and the capture pipeline,
storage, AI queue and Drive filing all exist.

## 2. What gets built (V1 scope)

One new surface + one table + one nightly sync:

- **Capture sheet** launched from a prominent camera button on the crew job page
  (`/my-jobs/[id]`) and the office/estimator lead page — full-screen, dark,
  one-thumb. Three modes: **Photo · Video · Voice note.** Job context auto-attached.
- **Optional, never-blocking enrichment**: after a capture, a single chip row
  (Before / After / Access / Team / Story) + optional one-line caption. Skippable;
  the capture is already saved.
- **Voice notes → transcripts** via the existing Gemini `ai_jobs` queue (new job
  type). Transcript lands on the record and travels with the audio.
- **Office review**: a gallery card on the lead page + a `/content` review queue —
  play/read everything, then one tap **"Approve for marketing"** per item.
- **Nightly Drive sync (i9)**: approved items file to the hub
  (`08 Media Library/real/jobs/…`) where the social/GBP agents already look.
- **Consent guard**: per-job "customer OK with photos" toggle + first-capture
  reminder (§7 — this is homes and possessions, not a building site).

Explicitly NOT in V1: GPS auto-assignment (unneeded — the job page is the context),
photo annotation/drawing, before/after collage composer, in-panel post drafting
(the RBS-OS agents own generation), customer-facing galleries.

## 3. The capture UX (the slick part)

**Entry.** On the crew job page: a fixed bottom-right camera FAB (56px, mm-red,
above the safe area) — one tap opens the capture sheet. Estimators get the same
button on the lead page + survey flow. The FAB shows a count badge of today's
captures on this job.

**The sheet** (full-screen overlay, charcoal, `100dvh`, thumb-zone controls):

- **Mode switcher** at the bottom: Photo · Video · Voice — big segmented control,
  Photo default. Mode persists per user.
- **Photo**: taps straight into the NATIVE camera (`<input capture="environment">` —
  the same proven path as crew job photos; zero permission drama on iOS PWA).
  Returns to the sheet with the shot in the tray. Multi-shot supported
  (`multiple`); client-side downscale to ~2000px JPEG (existing helper).
  **Two taps total from job page to filed photo.**
- **Video**: the AI-survey MediaRecorder pipeline reused (proven on iPad):
  in-sheet viewfinder, big record button, 60s soft cap with a ring countdown,
  720p, TUS resumable upload so a van-doorway signal drop never loses a clip.
- **Voice note**: WhatsApp ergonomics — **hold to record** with a live timer +
  pulsing level ring; **slide up to lock** for hands-free; release (unlocked) or
  tap stop (locked) → instant playback bar with re-record / keep. 3-minute cap.
  MediaRecorder audio (mp4/AAC on iOS — Gemini-compatible).
- **Tray**: captured items appear as thumbnails in a bottom rail with per-item
  upload progress; failed uploads show retry (never silently lost). Leaving the
  sheet never cancels uploads.
- **Enrichment (optional)**: tapping a tray item opens chips + caption. A voice
  note can be attached TO a photo/video ("talk over it") — the transcript then
  captions that item.
- Feedback: 10ms haptic on capture, brief toast on filed, press-scale 0.97,
  150–300ms transitions, `prefers-reduced-motion` respected. All targets ≥44px,
  16px inputs, safe-area insets — the house iPad rules.

**Why native-camera + in-sheet recorder rather than a full custom camera:** a
continuous custom viewfinder (CompanyCam-style) is a native-app luxury; on iOS
PWAs `getUserMedia` viewfinders carry rotation/memory/permission quirks. The
native capture input is instant and familiar for photos; the MediaRecorder path
is already field-proven here for video. Slick = fast and reliable, not clever.

## 4. Data model + storage

New table `job_media` (RLS: staff insert/read own-job, office all, admin delete):

| column | notes |
|---|---|
| id, lead_id, appointment_id?, client_id | job anchoring (lead = the job spine) |
| kind | photo · video · audio |
| storage_path | private bucket `job-media`, path validated per lead/appointment |
| caption, tag | tag ∈ before/after/access/team/story/other, both optional |
| attached_to | media id an audio note narrates (optional) |
| consent_state | from the job's toggle at capture time (§7) |
| transcript, transcript_status | audio (and video soundtrack later); via ai_jobs |
| marketing_approved_at / _by | the office gate (§6) |
| captured_by, created_at, synced_at | attribution + Drive sync stamp |

Buckets/pipelines reused: TUS resumable (500MB cap already raised), signed URLs,
client downscale, the `ai_jobs` cron drainer + Gemini Files API + spend ledger
(transcription on flash-lite costs fractions of a penny per note).

## 5. Drive centralisation (the handoff Peter asked for)

**Recon fact:** the hub already has `08 Media Library/real/jobs/` (siblings:
`crew/`, `van/`, `enhanced/`), and the social agents' **real-photo** content class
picks images from library folders listed in `brands/marley-moves/brand.md` under
"Image reference assets" (`plan_week.py media_library()`), while GBP filing runs
through `agents/shared/media_library.py` — fail-soft when Drive is unmounted.

**Architecture: capture → Supabase (VPS) → nightly i9 sync → Drive hub.**
The VPS never touches Drive (keeps the narrow-token principle intact — no broad
Drive OAuth on the box); i9 already has `F:` mounted natively and runs the
nightly Marley tasks. A new RBS-OS script (`marley-job-media-sync`, silent
scheduled task) reads approved-and-unsynced rows via PostgREST, downloads via
signed URLs, and files:

```
08 Media Library/real/jobs/
  approved/                        ← flat marketing pool the agents point at
    2026-07-18_MMR012_after_01.jpg      (date_ref_tag_seq naming)
  <YYYY-MM>_<quote-ref>/           ← per-job archive (everything approved)
    media files + transcripts.md   (voice-note transcripts + captions + context)
```

`approved/` gets added to brand.md's Image reference assets once seeded — from
then on the existing agents use real job content with **zero agent code changes**;
transcripts.md gives the copywriter authentic detail ("third-floor flat in
Sherborne, piano down a spiral staircase…") for GBP/FB copy.

## 6. Office review + approval gate

Everything captured is visible immediately (lead page gallery card + `/content`
queue: newest first, filter by job/kind/status, inline play + transcript).
**Only office-approved items sync to Drive/marketing.** Two reasons: quality (the
agents should never pick a blurry floor shot) and consent (§7). Approval is one
tap; bulk-approve per job exists. Internal-only content (access notes, damage
evidence) stays in the panel forever regardless — capture is useful even when
it's never marketing.

## 7. Consent + privacy (flag-danger section)

Jobs happen inside customers' homes. Filming there for marketing without consent
is a GDPR/reputation problem, not a UX detail:

- **Per-job toggle** ("Customer is happy for photos/video — marketing OK") set by
  crew lead or office; captures inherit the state at capture time. Off = items
  are born internal-only and CANNOT be marketing-approved until it's flipped.
- **First capture on a job** shows a one-time bottom sheet: exteriors/van/crew
  always fine; interiors, possessions and people need the customer's OK.
- **T&Cs hook**: add a media clause at the upcoming legal review ("we may take
  photographs during your move for training and marketing; tell us if you'd
  rather we didn't") — makes the toggle's default defensible.
- Retention: internal-only media follows the same retention thinking as AI survey
  footage (review at the claims-module discussion); approved marketing content is
  business material and persists.

## 8. Build plan

| Phase | Work | Size |
|---|---|---|
| A | Migration (`job_media` + bucket + RLS) + upload actions reusing photo/TUS pipelines | M |
| B | Capture sheet (photo → video → voice, tray, enrichment chips) on crew job page + lead page | L (the UX is the product) |
| C | Transcription job type in `ai_jobs` + transcript display | S |
| D | Office review: lead-page gallery + `/content` queue + approve flow + consent toggle | M |
| E | i9 sync script + scheduled task + brand.md pointer + first seeded batch | S |
| F | Field pass on real phones (Connor's iPhone + a crew Android) before calling it done | — |

Roughly 2–3 build days plus the field pass. Weekly digest gains a "content
captured this week" line once live (one-line change).

## 9. Success measures

- ≥5 captures per completed job within the first month (CompanyCam-grade friction
  or better: photo filed in ≤2 taps from the job page).
- The social agents' real-photo class draws from `real/jobs/approved/` weekly.
- Zero marketing use of non-consented interior content (gate holds by construction).

## 10. Open questions for Peter

1. **Approval gate**: office approves each item before marketing use (recommended,
   one tap) — or is everything captured fair game for the agents?
2. **Consent posture**: per-job toggle + capture-time reminder + T&Cs clause
   (recommended) — enough, or do you want written/signed consent for interior shots?
3. **Estimators from day one?** Recommended yes — surveys produce great "story"
   material and Luke is on-site anyway.
4. **Voice-note ambition**: V1 = transcript filed with the media for the agents to
   use (recommended). Or should the panel itself draft a post from a voice note
   (bigger, duplicates the agents' job)?
5. **Who reviews /content** — office-wide or admins only? (Recommended: office.)
