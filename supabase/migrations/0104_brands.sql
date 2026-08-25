-- 0104: the brand layer — brands table, brand columns, per-brand ref counters
-- (docs/multi-brand-prd.md §3.1–§3.3, gate 1).
--
-- Marley Moves takes over Pitmans Removals & Storage: ONE legal entity
-- (MarleyMoves Ltd), one VAT registration, one bank account, one client spine —
-- brand is presentation and attribution, never financial isolation. Pitmans runs
-- inside this instance because the crew, vans and diary are one shared pool; a
-- second deployment would double-book them. The single-brand invariant (PRD §1)
-- governs everything here: with one active brand the app renders byte-identical
-- to today, so this migration is deliberately inert for live Marley behaviour —
-- every existing row backfills to 'marley' via column defaults, and the brand UI
-- only appears when a second brand row flips active.

-- ---------------------------------------------------------------- brands table
-- Slug PK ('marley' | 'pitmans' | 'group') so brand columns read as plain text
-- with no join needed for display fallbacks. 'group' is the pseudo-brand for
-- cross-brand surfaces (day sheet, /join, /manual, contractor statements) — it
-- has no ref prefix and mints nothing.
create table brands (
  slug              text primary key,        -- 'marley' | 'pitmans' | 'group'
  name              text not null,           -- 'Pitmans Removals & Storage'
  short_name        text not null,           -- 'Pitmans'
  initial           char(1),                 -- 'P' | 'M'  (diary meta line)
  group_line        text not null,           -- 'Part of the Marley Group'
  legal_line        text not null,
  ref_prefix        text unique,             -- 'MM' | 'PM'  (null for 'group')
  colour_primary    text,
  colour_accent     text,
  logo_url          text,
  group_logo_url    text,
  email_domain      text,
  hello_from        text,
  accounts_from     text,
  reply_domain      text,
  sms_sender        text,
  phone             text,
  address           text,
  website_url       text,
  review_url        text,
  terms_url         text,
  base_location     text,                    -- null → business_settings.base_location
  card_payments_enabled boolean not null default false,
  ledger_branding_id    text,                -- Xero BrandingThemeID (org-specific, never hardcoded)
  resend_template_ids   jsonb not null default '{}'::jsonb,
  active            boolean not null default true,
  sort_order        int not null default 0
);

-- RLS mirrors business_settings (0005): any active staff can read; only admins
-- can change. Structural fields (slug, ref_prefix, active) are additionally
-- guarded at the UI layer — a changed ref prefix would break bank reconciliation
-- on refs already issued, so creating brands stays a migration.
alter table brands enable row level security;
create policy brands_read   on brands for select using (is_staff());
create policy brands_update on brands for update using (is_admin());
create policy brands_insert on brands for insert with check (is_admin());

-- ------------------------------------------------------------------ seed rows
-- Marley: every value below is the LIVE string read from the code it replaces —
-- lib/comms/sender.ts (email domain, hello/accounts identities, reply domain),
-- lib/comms/branded-shell.ts (logo URL, colours, the STANDARD_FOOTER legal
-- line) and app/q/[token]/page.tsx (phone, terms URL). Note the /q footer
-- currently renders "Marley Moves Ltd · … · Shaftesbury, SP7" — a known drift
-- from the legal one-word name; the email shell's legally-correct line is
-- seeded here. review_url stays null: business_settings.google_review_url is
-- the live source until gate 13 adds brand resolution with a marley fallback.
insert into brands (
  slug, name, short_name, initial, group_line, legal_line, ref_prefix,
  colour_primary, colour_accent, logo_url, email_domain, hello_from,
  accounts_from, reply_domain, phone, address, website_url, review_url,
  terms_url, card_payments_enabled, active, sort_order
) values (
  'marley', 'Marley Moves', 'Marley', 'M', 'Part of the Marley Group',
  'MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58', 'MM',
  '#1A1A1A', '#C03838', 'https://marleymoves.co.uk/logo.png',
  'marleymoves.co.uk', 'hello@marleymoves.co.uk', 'accounts@marleymoves.co.uk',
  'reply.marleymoves.co.uk', '01747 637070', null, null, null,
  'https://marleymoves.co.uk/terms-conditions/', true, true, 0
) on conflict (slug) do nothing;

-- Pitmans: seeded ACTIVE FALSE as the prod-safe default — production must stay
-- single-brand (UI byte-identical to today) until the 18 September promotion is
-- verified; STAGING IS FLIPPED TO active = true BY HAND after this migration
-- applies there, so every gate review shows the brand work. Colours sampled
-- from pitmansremovals.co.uk 2026-08-25 (blue primary for UI, yellow only for
-- large flat areas). accounts@ is provisional (Phase 0 — mailbox list pending
-- Mark); logo_url null until the Phase 0 asset arrives; terms_url null renders
-- Marley terms until gate 15 ships the unified brand-neutral document.
-- review_url null = the Pitmans Google review link is Phase 0 pending — and
-- gate 13 must NOT fall back to business_settings.google_review_url for
-- Pitmans (that is MARLEY'S listing — the exact brand-leak class §6.4 scans
-- for). A brand with no review_url simply doesn't send the review email,
-- mirroring the existing only-sends-when-set behaviour.
insert into brands (
  slug, name, short_name, initial, group_line, legal_line, ref_prefix,
  colour_primary, colour_accent, logo_url, email_domain, hello_from,
  accounts_from, reply_domain, phone, address, website_url, review_url,
  terms_url, card_payments_enabled, active, sort_order
) values (
  'pitmans', 'Pitmans Removals & Storage', 'Pitmans', 'P', 'Part of the Marley Group',
  'Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266. VAT 520 2213 58.', 'PM',
  '#2B2B76', '#FFCC00', null,
  'pitmansremovals.co.uk', 'info@pitmansremovals.co.uk', 'accounts@pitmansremovals.co.uk',
  'reply.pitmansremovals.co.uk', '01258 858564',
  'Uplands Business Park, Blandford Heights, Shaftesbury Road, Blandford Forum, Dorset DT11 7UZ',
  'https://pitmansremovals.co.uk', null, null, false, false, 1
) on conflict (slug) do nothing;

-- Group: the cross-brand pseudo-brand. No ref prefix (mints nothing), no email
-- domain (group comms keep Marley's from-address — PRD §11.10), empty
-- group_line (a group surface never says "part of" itself). sort_order 99
-- keeps it out of any brand-ordered UI listing by accident.
insert into brands (
  slug, name, short_name, initial, group_line, legal_line, ref_prefix,
  colour_primary, colour_accent, logo_url, email_domain, hello_from,
  accounts_from, reply_domain, phone, address, website_url, review_url,
  terms_url, card_payments_enabled, active, sort_order
) values (
  'group', 'Marley Group', 'Group', null, '',
  'MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58', null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  false, true, 99
) on conflict (slug) do nothing;

-- --------------------------------------------------------------- brand columns
-- leads.brand is the source of truth, denormalised to quotes and appointments
-- so the diary colours a row without a join (PRD §3.2). NOT NULL DEFAULT
-- 'marley' backfills every existing row in the same statement — live data is
-- all Marley by definition. Deliberately NOT on clients (shared spine: one
-- person contacting both brands is one client with two leads), staff,
-- appointment_assignments or business_settings.
alter table leads         add column brand text not null default 'marley' references brands(slug);
alter table quotes        add column brand text not null default 'marley' references brands(slug);
alter table appointments  add column brand text not null default 'marley' references brands(slug);

-- Storage: a let inherits brand from the customer's originating lead, falling
-- back to its site — both carry the column so that fallback is data, not code.
alter table storage_sites add column brand text not null default 'marley' references brands(slug);
alter table storage_lets  add column brand text not null default 'marley' references brands(slug);

-- Vehicles: livery only, so NULLABLE with no default — null means
-- unbranded/shared and never mismatches. Existing fleet stays null; the office
-- tags vans at leisure from /resources. Drives the soft allocation warning and
-- nothing else — the fleet is one pool and livery never restricts allocation.
alter table vehicles      add column brand text references brands(slug);

-- ---------------------------------------------------------- brand ref counters
-- Replaces the two fixed sequences (0037) with one row per brand × kind, so
-- next_quote_ref can mint MMR042 and PMR001 from the same code path (PRD §3.3).
-- The atomic `update … returning` under the row lock is collision-proof like
-- the sequences were, and the counter row is the thing a go-live flush must
-- never reset (see scripts/reset-data.mjs — reissuing a ref would let the
-- ledger's -DEP/-BAL reference adoption bind a stale invoice to a new quote).
create table brand_ref_counters (
  brand text not null references brands(slug),
  kind  text not null check (kind in ('R', 'C')),
  n     bigint not null default 0,
  primary key (brand, kind)
);

-- RLS posture mirrors the sequences it replaces: enabled with NO policies, so
-- no client role can read or write rows directly. All access goes through the
-- SECURITY DEFINER next_quote_ref() below (which owns the table the way 0037's
-- function owned its sequences); service_role bypasses RLS for ops scripts.
alter table brand_ref_counters enable row level security;

-- Seed Marley's counters from the CURRENT sequence positions so numbering
-- continues unbroken (MMR041 issued → next is MMR042). A sequence that was
-- never called reports last_value = 1 with is_called = false, which means
-- nothing was issued — that seeds 0, so the first increment returns 1.
--
-- RACE, stated honestly: sequence reads are non-transactional, so a quote
-- accepted between this read and the migration's COMMIT mints from the old
-- function while the counter below misses it — the first post-migration mint
-- would then reissue that same ref. Apply this file in a quiet window (no one
-- issuing quotes), and the runbook's verify step reconciles the counter
-- against the sequence with greatest() afterwards, which closes the window
-- deterministically. See docs/pitmans-prod-migration-runbook.md.
insert into brand_ref_counters (brand, kind, n)
select 'marley', 'R', case when is_called then last_value else 0 end
from public.quote_ref_mmr_seq
on conflict (brand, kind) do nothing;

insert into brand_ref_counters (brand, kind, n)
select 'marley', 'C', case when is_called then last_value else 0 end
from public.quote_ref_mmc_seq
on conflict (brand, kind) do nothing;

insert into brand_ref_counters (brand, kind, n)
values ('pitmans', 'R', 0), ('pitmans', 'C', 0)
on conflict (brand, kind) do nothing;

-- The old sequences are retired IN PLACE, not dropped: nothing reads them after
-- this migration (grep confirms next_quote_ref was their only caller), and
-- keeping them makes reverting this function change a one-liner instead of a
-- restore-from-backup. Do NOT read them for numbering — brand_ref_counters is
-- the source of truth from here on.

-- ------------------------------------------------- next_quote_ref(kind, brand)
-- Same function, brand-aware. The second argument DEFAULTS to 'marley', so the
-- existing sb.rpc('next_quote_ref', { kind }) call sites keep working entirely
-- unchanged — PostgREST fills the default for the missing named argument.
-- DROP first: the signature changes (text) → (text, text), and CREATE OR
-- REPLACE would otherwise add an ambiguous overload beside the old function.
--
-- Security posture carried over verbatim from 0037/0038 (PRD §11.7 trap 5):
-- SECURITY DEFINER purely to own the counter table (RLS blocks direct access);
-- empty search_path; the is_office() gate on interactive callers (crew must not
-- burn counter values — office RLS on quotes already blocks their inserts, this
-- keeps the counter consistent with that); execute revoked from public + anon,
-- granted to authenticated + service_role only.
drop function public.next_quote_ref(text);

create function public.next_quote_ref(kind text, brand text default 'marley')
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  next_n bigint;
  prefix text;
begin
  if auth.uid() is not null and not public.is_office() then
    raise exception 'quote references are minted by office users only' using errcode = '42501';
  end if;

  if kind not in ('R', 'C') then
    raise exception 'quote ref kind must be R or C, got %', kind using errcode = '22023';
  end if;

  -- Unknown slug, or a brand that mints nothing ('group'), is a caller bug —
  -- fail loudly rather than inventing a prefix.
  select b.ref_prefix into prefix
  from public.brands b
  where b.slug = next_quote_ref.brand;
  if prefix is null then
    raise exception 'no quote-ref prefix for brand %', brand using errcode = '22023';
  end if;

  -- Atomic increment under the row lock — concurrent callers serialise on the
  -- (brand, kind) row and can never receive the same n.
  update public.brand_ref_counters c
     set n = c.n + 1
   where c.brand = next_quote_ref.brand
     and c.kind = next_quote_ref.kind
  returning c.n into next_n;
  if not found then
    raise exception 'no ref counter row for brand % kind %', brand, kind using errcode = '22023';
  end if;

  -- lpad TRUNCATES past its length ('1000' → '100'), which would collide
  -- MMR1000 with MMR100 — 0037 intended MMR999 → MMR1000, so pad only under
  -- four digits and let the ref grow naturally beyond.
  return prefix || kind ||
    case when next_n < 1000 then pg_catalog.lpad(next_n::text, 3, '0') else next_n::text end;
end
$function$;

revoke all on function public.next_quote_ref(text, text) from public, anon;
grant execute on function public.next_quote_ref(text, text) to authenticated, service_role;

-- Self-hosted PostgREST caches the schema, and this migration DROPs the exact
-- function signature that cache routes rpc('next_quote_ref') through — without
-- a reload every quote creation on prod errors until someone remembers the
-- manual notify (docs/multi-brand-prd.md §11.1). Hosted staging reloads itself;
-- this line is what makes the prod apply safe.
notify pgrst, 'reload schema';
