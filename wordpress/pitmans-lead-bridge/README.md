# Pitmans Lead Bridge (WordPress plugin)

Bridges the quote form on `pitmansremovals.co.uk` into Marley Ops. Three jobs,
in this order:

1. **Persist** — every matching Contact Form 7 submission is written to a
   dedicated table (`{prefix}plb_submissions`) *before* any network call. This
   write must succeed even when the push fails; it is the record everything
   else recovers from.
2. **Push** — the submission is POSTed to
   `https://ops.marleymoves.co.uk/api/ingest/lead` with the Pitmans ingest
   secret, so the lead lands in the panel within seconds. Failures are recorded
   on the row (`pushed_at` stays NULL) and retried one-at-a-time on later
   submissions.
3. **Signed read endpoint** — Ops polls
   `GET /wp-json/pitmans-lead-bridge/v1/submissions` (HMAC-signed) every 15
   minutes and reconciles anything the push missed.

## ⚠️ This plugin WITHOUT the pull rail is a silent-loss configuration

Do not treat step 2 as the integration. A push-only setup loses enquiries
*silently*: when the push breaks (expired secret, DNS, TLS, an Ops outage, a
WordPress update that unhooks the form), nothing on either side says so — the
enquiries simply stop arriving, and the surface that would have shown the gap
is exactly the one the failure emptied. That is the failure mode
`docs/multi-brand-prd.md` §3.8 calls out, and it is why this plugin **ships
together with** the Ops pull cron (`/api/cron/wp-leads`, code in
`lib/sync/wp-leads.ts`).

Installation is not finished until **both** of these are true:

- The plugin is active with a filled-in `config.php` (below), **and**
- `PITMANS_WP_PULL_URL` + `PITMANS_WP_PULL_SECRET` are set in the marley-ops
  environment (`/opt/marley-ops/app.env`) and the `wp-leads` cron line is live
  (see `docs/ovh-deployment.md`). Until then that cron reports
  `configured: false` on every run — that report going quiet-green is the
  sign-off, not the plugin activating.

## Install

1. Build the zip from this directory (from the repo root):

   ```
   cd wordpress && zip -r pitmans-lead-bridge.zip pitmans-lead-bridge -x "pitmans-lead-bridge/config.php"
   ```

   `config.php` must never travel in the zip — it holds live secrets and is
   created on the WordPress box only.
2. WordPress admin → Plugins → Add New → Upload Plugin → the zip → Activate.
   Activation creates the `{prefix}plb_submissions` table.
3. On the server (or via the file manager), copy
   `wp-content/plugins/pitmans-lead-bridge/config-sample.php` to `config.php`
   in the same directory and fill it in:
   - `form_ids` — the CF7 form id(s) from the form shortcode.
   - `ops_ingest_secret` — must equal `LEAD_INGEST_SECRET_PITMANS` in the
     marley-ops environment (that secret is what maps the push to the
     `pitmans` brand — the brand derives from the secret, never the payload).
     Generate with `openssl rand -hex 32`; the same value goes in both places.
   - `pull_secret` — a *different* secret; the same value goes into
     `PITMANS_WP_PULL_SECRET` on the Ops side.
   - `field_map` — the real CF7 field names, read off the form editor's tags
     (`[text* your-name]` → `your-name`). The sample's names are typical CF7
     defaults, **not** verified against the live form.
4. Check wp-admin for the plugin's notices — it complains loudly when
   `config.php` is missing, secrets are placeholders, or no form ids are set.
5. Configure the Ops side (env vars + cron), then submit a test enquiry and
   confirm: the lead appears in Ops within seconds (push), and the next
   `wp-leads` cron run reports it under `alreadyPresent` (pull).

The plugin is form-stack-generic by design: the CF7 hook (`wpcf7_before_send_mail`)
is the only CF7-specific line, and every form id and field name is config. If
the site ever rebuilds its form, edit `config.php`, not the plugin.

## The id contract

```
external_lead_id = "wp-" + <row id zero-padded to 6 digits>     e.g. wp-000042
```

- The row id is the AUTO_INCREMENT primary key of `{prefix}plb_submissions`.
- Both sides derive the id independently from the same row id: the plugin when
  it pushes (`plb_external_lead_id()`), and Ops when it reconciles
  (`wpExternalLeadId()` in `lib/sync/wp-leads.ts`). That is what lets either
  delivery route recognise the other's work — a pushed lead is found, not
  re-inserted, by the pull.
- The padding matters: the Ops ingest schema requires ids of at least 8
  characters (`wp-1` would be rejected). Ids past 999999 simply grow longer.
- **Never reset the table's AUTO_INCREMENT and never renumber rows.** A reused
  id maps to an external id Ops has already landed, so the new enquiry would
  be swallowed as "already present" — silently. Deleting old rows is safe
  (AUTO_INCREMENT keeps counting); `TRUNCATE` is not (it resets the counter).

## The signed read endpoint

```
GET /wp-json/pitmans-lead-bridge/v1/submissions?limit=<n>&since_id=<n>&ts=<unix-seconds>&sig=<hex>
sig = HMAC-SHA256("limit=<n>&since_id=<n>&ts=<unix-seconds>", pull_secret)
```

- Canonical string is exactly `limit=<n>&since_id=<n>&ts=<unix>` — plain
  integers, that parameter order, nothing else. The Ops half of the contract is
  `signPullQuery()` in `lib/sync/wp-leads.ts`; change both together or not at
  all.
- `since_id` is **signed and required**. Signed, so an on-path observer cannot
  advance the reader's window and hide a row from the only backstop the enquiry
  has. Required rather than defaulting to 0, so a caller that forgot it cannot
  read exactly like a caller that meant it.
- `ts` must be within ±300 seconds of the server clock (bounded replay window
  on a read-only endpoint). `limit` is 1–500; `since_id` is ≥ 0.
- Returns up to `limit` submissions with `id > since_id`, **oldest first**:
  `id`, `form_id`, `submitted_at` (UTC ISO), `pushed_at` (or null),
  `push_attempts`, `last_error`, and the stored `payload` (`ingest` = the mapped
  lead fields sans `leadId`; `raw` = the sanitised form fields, kept for
  debugging).
- Also returns `total` (rows in the whole table), `since_id` (echoed) and
  `remaining` (rows beyond this page). **`total` is what lets the reader PROVE
  nothing is missing** rather than infer it from a window that by construction
  cannot show what it excluded. It used to answer the newest `limit` rows with
  no cursor and no total, so anything that fell behind that window was offered
  by no poll ever again — and because the reader's failure count then read zero,
  its standing reconcile alarm resolved itself. Do not remove `total`: Ops
  treats its absence as UNKNOWN and holds the alarm open, which is correct but
  noisy.
- Row ids are the cursor, so **never reset AUTO_INCREMENT** on the submissions
  table.
- Unauthenticated/badly-signed requests get an undifferentiated 403; an
  unconfigured pull secret returns 503 (fail closed, never open).

## Operational notes

- **No wp-cron.** wp-cron only fires on site traffic, which would make the
  retry channel fail at exactly the quiet moments a failure hides in. Push
  retries piggyback on later submissions (one older row per submission, capped
  at 10 attempts); the Ops pull cron — on Ops's own clock — is the real drain.
- A push rejected with HTTP 400 is marked `permanent:` and not re-pushed (it
  will never be accepted — e.g. a submission with no phone *and* no email).
  The pull rail still sees the row and surfaces it as a reconcile failure on
  the Ops side, where a human can look.
- Secrets are never logged, never echoed, and never included in any response.
- Deactivating/uninstalling leaves the table in place — the rows are business
  records of real enquiries.
- PHP 7.4+ (typical WP hosting). No Composer, no build step.
