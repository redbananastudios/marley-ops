# Marley Ops — OVH self-hosted deployment (runbook)

As of **2026-07-13** `ops.marleymoves.co.uk` + its Supabase backend run entirely on a
dedicated **OVH VPS** — off Vercel and off the shared vps1. This is the operations +
rollback reference.

## Where everything runs

| Piece | Detail |
|---|---|
| **VPS** | `vps-a0b9c066.vps.ovh.net` · `51.195.253.165` · Ubuntu 26.04 · 6 vCPU / 11 GiB / 96 GB |
| **SSH** | `ubuntu@51.195.253.165`, key `~/.ssh/rbs_vps` (i9). **Key-only** (password login disabled). Passwordless sudo. |
| **Firewall** | UFW allows 22 / 80 / 443 — **but UFW does NOT govern Docker-published ports** (see "Network exposure" below). Container port publishing is filtered in the `DOCKER-USER` iptables chain via `docker-user-firewall.service`. |
| **App** | Docker container `marley-ops-app` (image `marley-ops:latest`, Next.js standalone), on the `rbs` network, published `127.0.0.1:3000` |
| **Backend** | Supabase stack under `/opt/rbs/supabase` (`docker compose`), 11 services, on `rbs` |
| **Reverse proxy** | Caddy (`/opt/rbs/caddy`) — auto Let's Encrypt TLS. Routes `ops.marleymoves.co.uk`→app:3000, `supabase.redbananastudios.com`→supabase-kong:8000. Has internal network aliases for both hostnames so the app reaches the backend without a public hairpin. |
| **App env** | `/opt/marley-ops/app.env` (chmod 600, 54 vars) — the runtime env; also holds the `NEXT_PUBLIC_*` build args |
| **Cron** | `/etc/cron.d/marley-ops` → `cron-hit.sh` fires the jobs against `localhost:3000` with `CRON_SECRET` (replaces Vercel Cron). Registry: `lib/cron/jobs.ts`. **When adding a job (e.g. `card-reconcile`, `*/15`), add its endpoint to `cron-hit.sh` on the VPS** — the in-repo registry drives the /automations page, not the scheduler. |
| **DNS** | Both records A → `51.195.253.165`, at IONOS, TTL 60 |
| **Backups** | `scripts/backup-prod-db.ps1` (nightly on i9, 02:30) → SSH pg_dump from the OVH `supabase-db` → `../backups` |

## Network exposure (PCI hardening, 2026-07-29)

**Do not trust `ufw status` on this box.** Docker publishes container ports with its own
iptables DNAT rules, which are evaluated *before* UFW's INPUT chain — so a published port
is reachable from the internet even though `ufw status` lists only 22/80/443. This bit us:
`supabase-pooler` published `0.0.0.0:5432` and `0.0.0.0:6543`, leaving **Postgres open to
the whole internet** behind nothing but the DB password. Found during the PCI DSS ASV scan
(flagged High: "Database Accessibility (External Scan)").

Fix in place:

| Piece | Detail |
|---|---|
| Script | `/usr/local/sbin/docker-user-firewall.sh` — flushes and rebuilds the `DOCKER-USER` chain |
| Rule | `RETURN` for `51.179.200.95` (i9) on 5432/6543, `DROP` for all other sources on `ens3` |
| Persistence | `docker-user-firewall.service` (systemd, `After=docker.service`, enabled) — required because Docker recreates `DOCKER-USER` **empty** on daemon start |

To change who may reach the DB, edit `ALLOW` in the script and re-run it (or
`sudo systemctl restart docker-user-firewall`). Verify a rule actually bites by removing the
allow entry and testing from i9 — a successful connection from an allowlisted IP alone does
not prove the DROP works.

**SSH algorithms.** `/etc/ssh/sshd_config.d/10-pci-macs.conf` restricts MACs to
`hmac-sha2-256-etm`, `hmac-sha2-512-etm`, `umac-128-etm` (the defaults offered `hmac-sha1`
and `umac-64`, flagged Medium by the ASV). Ciphers and KEX were already clean.

> **Editing sshd on this box:** always arm an auto-revert first —
> `sudo systemd-run --unit=ssh-revert --on-active=300 /bin/bash -c "rm -f /etc/ssh/sshd_config.d/<file> && systemctl reload ssh"` —
> then `sshd -t`, reload, open a **fresh** connection to prove access, and only then
> `systemctl stop ssh-revert.timer`. SSH here is one-shot from i9; a bad config locks us out.

PCI context, portal login and scan schedule: memory `marley-pci-compliance`.

## Deploy an app update

**Primary — GitHub CI/CD (automatic).** Push to `master` → `.github/workflows/deploy.yml`
runs the test gate (lint + tsc + 278 tests) on a GitHub-hosted runner, then, only if
green, the **self-hosted runner on the OVH box** builds the image (baking `NEXT_PUBLIC_*`
from `/opt/marley-ops/app.env`), restarts `marley-ops-app`, and health-checks `/login`.
Nothing else to do — just `git push`. Trigger manually via the Actions tab
(`workflow_dispatch`) if needed.

- Runner service: `actions.runner.redbananastudios-marley-ops.ovh-vps` (systemd, enabled).
  Health: `sudo ./svc.sh status` in `/opt/actions-runner`. Re-register with a fresh token
  from `gh api -X POST repos/redbananastudios/marley-ops/actions/runners/registration-token`.

**Fallback — manual push from i9** (if the runner is down): `bash scripts/deploy-ovh.sh`
transfers the working tree, rebuilds, restarts, and smoke-tests.

## Apply a DB migration to prod

```bash
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "sudo docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < supabase/migrations/00NN_x.sql
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "sudo docker exec supabase-db psql -U postgres -d postgres -c \"notify pgrst, 'reload schema';\""
```

## Apply a DB migration to STAGING (do this FIRST — dress-rehearsal)

Staging is the hosted Supabase cloud project `nrghwyfakrgobcczuuca` (**eu-west-1**, despite
the design doc saying London). Connect from i9 with node `pg` via the session pooler —
host `aws-0-eu-west-1.pooler.supabase.com:5432`, user `postgres.nrghwyfakrgobcczuuca`,
db `postgres`, TLS on. Password: `MARLEY_STAGING_SUPABASE_DB_PASSWORD` in
`F:\My Drive\workspace\credentials.env` (added 2026-08-07 — never hardcode it).
Wrap the migration in a transaction, print the affected constraint/table definitions
before AND after, `ON_ERROR_STOP` semantics via try/rollback. First applied: 0086.
(The eu-west-2 pooler hosts reject the ref — don't waste time on them.)

## Change an env var

Edit `/opt/marley-ops/app.env` on the box, then **RECREATE** the container:

```bash
sudo docker rm -f marley-ops-app
sudo docker run -d --name marley-ops-app --restart unless-stopped \
  --network rbs -p 127.0.0.1:3000:3000 --env-file /opt/marley-ops/app.env marley-ops:latest
```

**`docker restart` is NOT enough and fails silently.** `--env-file` is read by the
Docker CLI at `docker run` and baked into the container's config; a restart reuses
that config, so the edited file is never re-read. The app keeps the OLD value with
nothing in any log saying so — which reads exactly like a broken feature rather
than a stale variable. (Cost an hour on staging, 2026-08-20: a correct
`LEAD_INGEST_SECRET` kept answering 401 until the container was recreated.)
A normal deploy already does `rm -f` + `run`, so setting a var **before** a deploy
needs no separate step.

If it's a `NEXT_PUBLIC_*` var it must also be rebuilt (re-run `deploy-ovh.sh`) —
those are inlined into the client bundle at build time, not read at runtime.

### `LEAD_INGEST_SECRET` — the website's direct lead post

`POST /api/ingest/lead` is how marleymoves.co.uk hands an enquiry straight to the
panel instead of leaving it in a public Sanity dataset for the sync to find. It
authenticates on `Authorization: Bearer <LEAD_INGEST_SECRET>` — one long random
string, the SAME value in this box's `app.env` and in the site's Vercel env for
the matching environment (staging talks to staging, prod to prod).

It **fails closed**: blank, missing, or shorter than 16 characters and every post
is refused with a 401, which the site treats as a failure and falls back to
emailing the office. A lead is never lost by this, but nothing lands in the panel
either — so if enquiries stop appearing, grep the app logs for
`lead-ingest.secret_unconfigured` before looking anywhere else.

Rotating it needs both sides changed within the same window; leads submitted in
between fall back to the office email rather than disappearing.

### Pitmans lead bridge (gate 19) — env + cron

The Pitmans WordPress site delivers enquiries down TWO rails that ship together
(multi-brand PRD §3.8 — push alone loses enquiries silently): the
`pitmans-lead-bridge` plugin pushes each submission to `/api/ingest/lead`, and
the `wp-leads` cron polls the plugin's signed read endpoint to land anything the
push missed. Plugin source + install guide: `wordpress/pitmans-lead-bridge/README.md`.

Three vars in `app.env` (recreate the container after, as above):

| Var | Pairs with |
|---|---|
| `LEAD_INGEST_SECRET_PITMANS` | `ops_ingest_secret` in the plugin's `config.php` — the push credential; its suffix IS the brand slug |
| `PITMANS_WP_PULL_URL` | the plugin's REST route, `https://pitmansremovals.co.uk/wp-json/pitmans-lead-bridge/v1/submissions` |
| `PITMANS_WP_PULL_SECRET` | `pull_secret` in `config.php` — a DIFFERENT secret from the push one, so one rotation never takes both rails down |

Cron line (add to `cron-hit.sh` / `/etc/cron.d/marley-ops` on the box, per the
Cron row above — **in the same deploy as the merge**, because the health
watchdog alerts on a registered job that never runs, which is exactly the
protection this rail needs):

```
*/15 * * * *  /api/cron/wp-leads
```

Until the pull env vars are set the job runs green but reports
`configured: false` with a loud warning — that state is part of the plugin's
install checklist, not noise. A half-set pair is a FAILED run on purpose.

## Rollback

**Vercel is deleted** (2026-07-13) — there is no longer a warm app fallback. Options:

- **Bad deploy** → roll the app back on the box: `git revert` + push (CI/CD redeploys the
  previous code), or on the box run a prior image tag / `sudo docker run … marley-ops:<prev>`.
- **Backend problem / catastrophic box loss** → the OVH box is now the only live copy
  (the old vps1 Supabase was **torn down 2026-07-13**). Recover by standing up a new box
  (Docker + Caddy + the `supabase/` stack), restoring the DB from the latest
  `../backups/marley-ops-*.dump` (nightly) — the final vps1 snapshot is
  `../backups/marley-ops-vps1-final-*.dump` — redeploying the app from git, and repointing
  both DNS records. Zone IDs: marleymoves.co.uk `1197dceb-63ff-11ef-adf4-0a5864441bc4`;
  redbananastudios.com `6da2bd83-2610-11f1-8196-0a5864441a59`.

## Decommission

- ✅ Vercel `marley-ops` project — **deleted 2026-07-13**.
- ✅ vps1 `supabase-*` stack — **torn down 2026-07-13** (`docker compose down`; Red Taxi on
  vps1 untouched). On-disk data left at `/opt/rbs/supabase/volumes` on vps1 as a short-term
  safety net — delete it (`docker compose down -v` + `rm -rf volumes`) once fully confident.
- Optional: raise the two IONOS DNS TTLs back to 3600 once the setup has stabilised.

## Xero (gate 18) — env, and what a Demo Company reset destroys

The ledger seam picks its provider from **`LEDGER_PROVIDER`** (`zoho` | `xero`; unset
means `zoho`, which is today's behaviour). An unrecognised value **throws** rather than
falling back — a typo'd `xerro` that silently resolved to Zoho would keep raising real
customer invoices in the system everyone had just stopped reading.

Flipping a box to Xero is an `app.env` edit plus a container recreate (as above). Every
variable below is **org-specific**, and every one fails closed naming itself rather than
guessing: putting real customer money in the wrong nominal account is the failure the
whole seam exists to make impossible.

| Var | What it holds | Unset behaviour |
|---|---|---|
| `LEDGER_PROVIDER` | `zoho` or `xero` | defaults to `zoho`; anything else throws |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | the developer app. Staging and prod are **separate apps** — Xero meters connections and API volume per app and they cannot share | integration unconfigured |
| `XERO_REDIRECT_URI` | must match the app's registered URI exactly | OAuth fails at consent |
| `XERO_ACCOUNT_BANKTRANSFER` / `_CASH` / `_CREDITCARD` | the **AccountID (GUID)** each payment rail posts to. Not the Code — Code is user-editable in the Chart of Accounts UI, so a bookkeeper renumbering the chart would silently re-point a rail | that rail throws; the others keep working |
| `XERO_ACCOUNT_INCOME` | the account **CODE** (e.g. `200`) that invoice lines post to. Deliberately the opposite form to the rails above — the two Xero APIs genuinely disagree, so the variables do too | every invoice raise throws |
| `XERO_ACCOUNT_STORAGE_INCOME` | the account **CODE** storage income posts to, keeping it out of Removals Income (standing policy 2026-07-22). To deliberately merge them, set it to the same code as `XERO_ACCOUNT_INCOME` — an explicit statement, not an absence | storage invoice raises **throw** naming the variable — there is no fallback to the general account (an unset variable is not a decision; the silent-fallback behaviour was removed) |
| `XERO_TAX_TYPE_VAT` / `_NO_VAT` | UK 20% output VAT is **`OUTPUT2`** — `OUTPUT` is the legacy 17.5% rate and is DELETED | throws rather than guess a tax rate |
| `XERO_CARD_ENABLED` | `"true"` or `"false"` — **a human attestation**, not a preference | a card-suppressed invoice **throws**. See below |
| `XERO_BRANDING_THEME_DEFAULT` | optional; omit to use the org's own default theme | Xero applies the org default |
| `XERO_BRANDING_THEME_NO_CARD` | a theme with **no payment service attached** | required only when `XERO_CARD_ENABLED=true` |
| `XERO_ORG_SHORTCODE` | the org's short code, for the "open in Xero" deep link on /finance | the button renders inert rather than pointing at the wrong organisation |
| `XERO_ALLOW_LIVE_WRITES` | **leave unset.** Set only at the cutover, deliberately | non-demo orgs are read-only |

### `XERO_CARD_ENABLED` has no safe default, on purpose

Balance invoices are BACS/cash only — card fees are too high at those values (Peter,
2026-07-09). Zoho honours that per invoice; **Xero cannot**, because online payment
services attach to a *branding theme*, so the only way to express "this invoice must not
be payable by card" is to raise it under a theme with no service attached.

Nothing in the app can ask Xero whether a theme offers card: the PaymentServices API is
open only to certified payment-service partners. So a human has to declare it — and an
**unset** variable is not a declaration. It is the state a cutover leaves behind, and
treating it as "card is off" is how that pricing decision gets reversed silently, with
the merchant statement as the only surface that would ever show it.

### The Demo Company resets every 28 days

Staging runs against Xero's Demo Company (there is no Xero sandbox). The reset destroys
**configuration, not just data**: the bank/cash/clearing accounts, any branding themes,
the VAT rates, the org short code, and the `ledger_tokens` row's `refresh_token` **and**
`tenant_id`. After each reset staging needs re-authorising AND every `XERO_*` id above
re-stamped. Next reset ~2026-09-24.

Two constraints with no workaround, both worth knowing before the cutover window rather
than inside it:

- **You cannot invite other users to a Demo Company.** Connor and Mark cannot be given a
  login to look at staging invoices the way they could with Zoho's Demo Removals.
- **An organisation may connect at most two uncertified apps.** If Connor's live org
  already has two (a bank feed, a receipt scanner), the prod app is refused at consent.

### Xero refresh tokens rotate on every use

Unlike Zoho's, a Xero refresh token is invalidated the moment it is used, so it **cannot**
live in `app.env` — two containers would race and lock the integration out. It lives in
the `ledger_tokens` table (migration `0108_ledger.sql`) under a single-writer row lock,
and `tenant_id` is read per call rather than latched (Xero: "always treat xero-tenant-id
as dynamic per request").
