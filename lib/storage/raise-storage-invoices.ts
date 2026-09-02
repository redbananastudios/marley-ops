import type { SupabaseClient } from "@supabase/supabase-js";
import { log, errorContext } from "@/lib/log";
import { DEFAULT_BRAND } from "@/lib/brand";
import { sendEmail } from "@/lib/comms/send";
import { accountsAddress, accountsFromFor } from "@/lib/comms/sender";
import { brandForComms } from "@/lib/comms/brand-theme";
import { emailTheme } from "@/lib/comms/email-brand";
import { cardPaymentsAvailable } from "@/lib/payments/card-payments";
import { asProvider, configuredProvider, createInvoice, findInvoiceByReference, findOrCreateContact, getInvoicePdfBase64 } from "@/lib/ledger";
import {
  invoicesDue,
  storageInvoiceReference,
  type BillableLet,
  type DueInvoice,
  type HandlingEventLite,
} from "@/lib/storage-billing";
import {
  buildStorageInvoiceEmailHtml,
  storageInvoiceSubject,
  type StorageInvoiceEmailInput,
} from "@/lib/comms/storage-invoice-email";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { paymentTermsDays, paymentTermsDueDate, resolvePaymentPolicy } from "@/lib/payments-policy";
import { UNIT_TYPES } from "@/lib/storage-units";
import { crateMinimumLabel } from "@/lib/signatures";

/**
 * SERVER ONLY — the shared "raise due storage invoices" core. The daily cron
 * runs it across every billable let; the release flow runs it for ONE let the
 * moment end_date lands, so the final invoice exists before goods leave
 * ("all charges settled before release" — docs/storage-billing-v2-prd.md §5).
 *
 * Money invariants carried over from the 0027 cron verbatim:
 *  - DB claim first (unique(let_id, period_start)); 23505 = another run won.
 *  - Zoho reference MMS-<let8>-<period> adopts an orphan after a crash.
 *  - On failure the still-pending claim is DELETED so the period retries —
 *    a surviving claim would read as "already billed" forever (under-bill).
 *  - Handling events are marked billed only AFTER the invoice write-back; a
 *    mark failure is surfaced as a billing failure (double-charge risk) and
 *    never silently swallowed.
 *
 * Hardening invariants (2026-07-22 review):
 *  - EVERY ledger read is strict — a failed or truncated read sets
 *    summary.fatal and the run raises NOTHING (partial data re-raises adopted
 *    periods and re-bills handling events).
 *  - An adopted orphan must match our computed total (±£0.005) or it is NOT
 *    adopted — a mismatched Zoho invoice is a human problem, alerted daily.
 *  - The claim records EXACTLY which handling events it sweeps
 *    (handling_event_ids); marking and repair mark BY THOSE IDS, never by
 *    recomputation, and verify the affected rowcount.
 *  - The write-back is checked: on failure the claim SURVIVES (the invoice
 *    exists in Zoho) and repairPendingStorageClaims() completes it next run.
 */

const gbp = (n: number): string => "£" + n.toFixed(2);

const prettyDay = (isoDay: string): string =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Inclusive day count from a to b (a ≤ b) — repair reconstructs the emailed
 *  period label from the stored claim, which carries no day count. */
const daysInclusive = (a: string, b: string): number =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000) + 1;

const EVENT_KIND_LABEL: Record<string, string> = { in: "in", out: "out", access: "access" };

function handlingSuffix(events: HandlingEventLite[]): string {
  if (!events.length) return "";
  const parts = events.map(
    (e) => `${EVENT_KIND_LABEL[e.kind] ?? e.kind} ${prettyDay(e.event_date)} ${gbp(Number(e.amount) || 0)}`,
  );
  return `; handling: ${parts.join(", ")}`;
}

/** Customer-facing line description per invoice kind. The minimum's wording
 *  follows the let's frozen min_kind (crateMinimumLabel) so the invoice says
 *  what the signed terms say — "one calendar month minimum" for storage-terms
 *  v2 lets, the day count for legacy 'days' lets. */
export function invoiceDescription(
  due: DueInvoice,
  unitLabel: string,
  dayRate: number,
  minKind?: string | null,
): string {
  const span = `${prettyDay(due.period_start)} – ${prettyDay(due.period_end)}`;
  switch (due.kind) {
    case "minimum":
      return `Storage: ${unitLabel}, ${crateMinimumLabel(minKind, due.days)} (${span})${handlingSuffix(due.handlingEvents)}`;
    case "arrears":
    case "final": {
      if (due.days === 0) return `Storage: ${unitLabel}${handlingSuffix(due.handlingEvents)}`;
      return `Storage: ${unitLabel}, ${due.days} day${due.days === 1 ? "" : "s"} (${span}) @ ${gbp(dayRate)}/day${handlingSuffix(due.handlingEvents)}`;
    }
    default:
      return `Storage: ${unitLabel}, ${span}`;
  }
}

/**
 * The kind-specific opening line. Brand-free by construction — it describes
 * the billing rule, which is the same whoever is billing.
 */
const NOTE_LEAD: Record<DueInvoice["kind"], string> = {
  period: "Storage is billed in advance per period.",
  minimum:
    "Your minimum storage period, billed in advance; further days are charged to the exact day in arrears.",
  arrears: "Storage days billed in arrears to the exact day.",
  final: "Final storage invoice. All charges are settled before items are released.",
};

/**
 * The customer-visible "how to pay" note on a storage ledger invoice.
 *
 * This was four fixed strings with one office number and one card offer baked
 * into each, resolved at module load — where no brand exists to resolve them
 * against. Every storage customer therefore read the same number and was
 * offered the same rail, whichever brand's let they were being billed for. A
 * customer of one brand ringing another brand's office reaches people who have
 * never heard of them, and a card offer is worse still: it names a channel
 * that may not exist, on a document they cannot argue with.
 *
 * Two independent facts were conflated into those literals: WHOSE invoice this
 * is, and whether card is live at all. They are separate here, exactly as
 * `invoicePayClause` separates them for the removals ladder.
 *
 * Pure, and takes the resolved values rather than a brand row: the card answer
 * needs the global kill switch as well as the brand's own flag (PRD §11.10),
 * and that lives in `business_settings`, which no pure function can see. The
 * caller ANDs them via `cardPaymentsAvailable` and passes the verdict in — so
 * "card is live" is decided in ONE place for this file rather than half-decided
 * in two.
 */
export function storageInvoiceNote(
  kind: DueInvoice["kind"],
  pay: { phone: string; cardPhone: boolean },
): string {
  // Card off means the word does not appear, not that it appears hedged: the
  // number still belongs on the invoice as a support line, which is why it
  // survives here while the rail does not.
  const how = pay.cardPhone
    ? `Pay by bank transfer using the invoice number as the reference, or by card over the phone on ${pay.phone}.`
    : `Pay by bank transfer using the invoice number as the reference. Any questions, call us on ${pay.phone}.`;
  return `${NOTE_LEAD[kind]} ${how}`;
}

const FOOTER_NOTES: Partial<Record<DueInvoice["kind"], string>> = {
  minimum:
    "This invoice covers your minimum storage period, billed in advance. After that, storage is charged to the exact day, in arrears. Whenever you're ready to arrange release, please get in touch and we'll book it in.",
  arrears:
    "Storage days are charged to the exact day, in arrears, every 4 weeks. Release is by appointment, with all charges settled before your items leave. Whenever you're ready, please get in touch and we'll book it in.",
  final:
    "This is your final storage invoice. All charges are settled before your items are released. If you have any questions, please get in touch.",
};

function periodLabelFor(
  due: Pick<DueInvoice, "kind" | "period_start" | "period_end" | "days">,
  minKind?: string | null,
): string {
  if (due.kind === "final" && due.days === 0) return "handling on release";
  const span = `${prettyDay(due.period_start)} – ${prettyDay(due.period_end)}`;
  // EVERY path passes minKind, because every path holds the let. The day-count
  // fallback below is only right for a legacy 'days' let: on a storage-terms-v2
  // let it would say "30-day minimum" in the body of an email whose attached
  // PDF — and the agreement the customer signed — both say one calendar month.
  if (due.kind === "minimum") return `${crateMinimumLabel(minKind, due.days)}, ${span}`;
  if (due.kind === "arrears" || due.kind === "final")
    return `${due.days} day${due.days === 1 ? "" : "s"}, ${span}`;
  return span;
}

const typeLabel = new Map<string, string>(UNIT_TYPES.map((t) => [t.value, t.label]));

function buildUnitLabel(
  unit: { unit_type?: string | null; code?: string | null; site_id?: string | null } | undefined,
  siteName: Map<string, string>,
): string {
  return `${typeLabel.get(unit?.unit_type ?? "") ?? "Storage unit"}${unit?.code ? ` ${unit.code}` : ""}${
    unit?.site_id && siteName.get(unit.site_id) ? ` at ${siteName.get(unit.site_id)}` : ""
  }`;
}

interface LetContextRow {
  id: string;
  unit_id: string | null;
  brand: string | null;
  min_kind: string | null;
}
interface UnitContextRow {
  id: string;
  code: string | null;
  unit_type: string | null;
  site_id: string | null;
}
interface ClientContextRow {
  id: string;
  display_name: string | null;
  email: string | null;
}

type StorageEmailContext =
  | {
      ok: true;
      letById: Map<string, LetContextRow>;
      unitById: Map<string, UnitContextRow>;
      siteName: Map<string, string>;
      clientById: Map<string, ClientContextRow>;
    }
  | { ok: false; error: string };

/**
 * Everything the two sweeps need to WORD a customer invoice email: the let (its
 * brand, its unit, its frozen minimum kind), the unit/site labels, and the
 * client's address.
 *
 * Refuses as a whole rather than degrading to empty maps, because every value
 * here is load-bearing on a send that stamps `emailed_at` on its way out and is
 * therefore never re-attempted. The let is the dangerous one: absent, `letBrand`
 * resolves to null and `emailStorageInvoice` words the mail as the DEFAULT
 * brand — so a transient PostgREST blip puts the DEFAULT brand's logo, From
 * address and phone number on another brand's storage bill, permanently, with
 * that brand's VAT PDF attached. Not sending is recoverable (the row keeps
 * `emailed_at is null`, so the un-emailed sweep retries it next run); a
 * mis-branded send is not. A failed `clients` read is the same class more
 * quietly: read as data it makes every row report "no customer email on file",
 * a claim nothing checked.
 */
async function loadStorageEmailContext(
  admin: SupabaseClient,
  letIds: string[],
  clientIds: string[],
): Promise<StorageEmailContext> {
  const [letsRes, unitsRes, sitesRes, clientsRes] = await Promise.all([
    admin.from("storage_lets").select("id, unit_id, brand, min_kind").in("id", letIds),
    admin.from("storage_units").select("id, code, unit_type, site_id"),
    admin.from("storage_sites").select("id, name"),
    admin.from("clients").select("id, display_name, email").in("id", clientIds),
  ]);
  const ctxErr = letsRes.error ?? unitsRes.error ?? sitesRes.error ?? clientsRes.error;
  if (ctxErr) return { ok: false, error: ctxErr.message };
  return {
    ok: true,
    letById: new Map(((letsRes.data ?? []) as LetContextRow[]).map((l): [string, LetContextRow] => [l.id, l])),
    unitById: new Map(((unitsRes.data ?? []) as UnitContextRow[]).map((u): [string, UnitContextRow] => [u.id, u])),
    siteName: new Map(
      ((sitesRes.data ?? []) as { id: string; name: string }[]).map((s): [string, string] => [s.id, s.name]),
    ),
    clientById: new Map(
      ((clientsRes.data ?? []) as ClientContextRow[]).map((c): [string, ClientContextRow] => [c.id, c]),
    ),
  };
}

export interface RaiseSummary {
  raised: number;
  emailed: number;
  errors: string[];
  billingFailures: string[];
  invoices: { letId: string; invoiceNumber: string; amount: number; kind: string }[];
  /** Set when a ledger read failed — the run raised NOTHING (raising on partial
   *  data double-bills); the caller must surface it and the next run retries. */
  fatal?: string;
}

/**
 * Adopt-or-flag decision for a claim whose Zoho orphan was found by reference.
 * Zoho totals are money — anything beyond a rounding whisker (±£0.005) means
 * the invoice does not bill what we computed and MUST go to a human, never
 * auto-adopt. An absent total (Zoho omitted the field) adopts: there is nothing
 * to verify against, matching the create path's trust in the reference.
 */
export function classifyPendingClaim(args: {
  zohoTotal: number | null | undefined;
  amount: number;
}): "adopt" | "mismatch" {
  if (typeof args.zohoTotal !== "number" || Number.isNaN(args.zohoTotal)) return "adopt";
  return Math.abs(args.zohoTotal - args.amount) > 0.005 ? "mismatch" : "adopt";
}

/** Mark swept handling events billed BY THEIR STORED IDS (still-unbilled only).
 *  Returns how many rows actually updated so callers can spot a mid-flight
 *  delete — fewer marks than ids means the customer was invoiced for a removed
 *  event, which needs a human reconcile in Zoho. */
async function markEventsBilled(
  admin: SupabaseClient,
  claimId: string,
  eventIds: string[],
): Promise<{ marked: number; error?: string }> {
  if (!eventIds.length) return { marked: 0 };
  const { data, error } = await admin
    .from("storage_handling_events")
    .update({ billed_invoice_id: claimId } as never)
    .in("id", eventIds)
    .is("billed_invoice_id", null)
    .select("id");
  if (error) return { marked: 0, error: error.message };
  return { marked: data?.length ?? 0 };
}

/** The customer invoice email (fail-soft — the invoice stands either way).
 *  Shared by the main raise loop and the pending-claim repair; the emailed_at
 *  stamp is guarded on `is null` so a repair re-attempt can never double-send
 *  a claim that already got its email. */
async function emailStorageInvoice(
  admin: SupabaseClient,
  args: {
    claimId: string;
    clientEmail: string;
    clientName: string | null;
    unitLabel: string;
    periodLabel: string;
    amount: number;
    kind: DueInvoice["kind"];
    invoiceId: string;
    /* Which ledger minted invoiceId (0109). Omitted on a freshly created
       invoice — that one is by definition from the configured provider. */
    invoiceProvider?: string | null;
    invoiceNumber: string;
    invoiceUrl: string | null;
    /** The let's brand slug (multi-brand PRD §3.5) — absent, or the default
     *  slug, sends today's exact email; another brand gets its own chrome,
     *  From address and the operating-company payment disclosure. */
    letBrand?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const brand = await brandForComms(admin, args.letBrand ?? "marley");
  const input: StorageInvoiceEmailInput = {
    firstName: (args.clientName ?? "").trim().split(/\s+/)[0] || "there",
    unitLabel: args.unitLabel,
    periodLabel: args.periodLabel,
    amountLabel: gbp(args.amount),
    invoiceNumber: args.invoiceNumber,
    invoiceUrl: args.invoiceUrl,
    footerNote: FOOTER_NOTES[args.kind],
    brand,
    // The email and the ledger note describe the SAME invoice, so they must
    // answer the card question the same way. Left unset, the email theme falls
    // back to the brand row alone — which ignores the global kill switch, and
    // would have this email offering card while the note on the very invoice
    // it attaches says bank transfer only. This is the explicit override
    // `emailTheme` documents for a caller that can see both switches.
    offerCardPhone: await cardPaymentsAvailable(admin, args.letBrand ?? null),
  };
  let pdf: string | undefined;
  try {
    pdf = await getInvoicePdfBase64(args.invoiceId, asProvider(args.invoiceProvider));
  } catch (e) {
    pdf = undefined; // email still sends, just without the VAT PDF
    log.warn("storage-billing.pdf_failed", { invoiceId: args.invoiceId, ...errorContext(e) });
  }
  const sent = await sendEmail({
    to: args.clientEmail,
    subject: storageInvoiceSubject(input),
    html: buildStorageInvoiceEmailHtml(input),
    attachments: pdf ? [{ filename: `${args.invoiceNumber}.pdf`, content: pdf }] : undefined,
    // Money desk identity — storage bills have no quote token, so replies go to
    // an accounts mailbox rather than a per-quote relay. `accountsAddress()` is
    // the DEFAULT brand's desk (and its ACCOUNTS_EMAIL override), so only the
    // default brand may name it: a default-brand Reply-To beside another
    // brand's From bounces that customer between two identities mid-thread, and
    // lands their reply in an inbox with no record of them. Unset, the send
    // path answers
    // with the brand's own front door (`emailReplyToFor`) — the same rule the
    // office ad-hoc compose follows.
    replyTo: brand.slug === DEFAULT_BRAND ? accountsAddress() : undefined,
    from: accountsFromFor(brand),
    brand,
  });
  if (!sent.ok) return { ok: false, error: sent.error ?? "send failed" };
  await admin
    .from("storage_invoices")
    .update({ emailed_at: new Date().toISOString() } as never)
    .eq("id", args.claimId)
    .is("emailed_at", null);
  return { ok: true };
}

export async function raiseDueStorageInvoices(
  admin: SupabaseClient,
  opts: { todayIso: string; letId?: string },
): Promise<RaiseSummary> {
  const today = opts.todayIso.slice(0, 10);
  const summary: RaiseSummary = { raised: 0, emailed: 0, errors: [], billingFailures: [], invoices: [] };

  // Lets that can still owe a period: open, or ended within the last 60 days.
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 60);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Strict ledger load — ANY read failure (or a truncated fetchAllRows window)
  // aborts via summary.fatal before a single invoice is raised. Partial data is
  // a money error: a missing invoices window re-raises billed periods; missing
  // clients would create junk "Storage customer" contacts in Zoho.
  const loadLedger = async () => {
    const lets = await fetchAllRows(
      (f, t) => {
        // Builders are single-use — rebuild the whole query per window.
        let q = admin
          .from("storage_lets")
          .select(
            "id, unit_id, client_id, brand, start_date, end_date, rate, rate_period, billing_paused, billing_model, min_days, min_amount, min_kind, notes",
          )
          .gt("rate", 0);
        q = opts.letId ? q.eq("id", opts.letId) : q.or(`end_date.is.null,end_date.gte.${cutoffIso}`);
        return q.order("id").range(f, t);
      },
      { strict: true },
    );
    const clientIds = [...new Set(lets.map((l) => l.client_id))];
    // No `.in(letIds)` on these two — a long uuid list overflows the GET URL
    // (the quotes-search 414 lesson) and under strict mode that would HALT
    // billing daily. Both tables are storage-scoped; read them whole (paged)
    // and let the per-let maps ignore rows for out-of-scope lets.
    const [invoices, unbilledEvents] = await Promise.all([
      fetchAllRows(
        (f, t) => {
          let q = admin.from("storage_invoices").select("let_id, period_start, handling_event_ids");
          if (opts.letId) q = q.eq("let_id", opts.letId);
          return q.order("id").range(f, t);
        },
        { strict: true },
      ),
      fetchAllRows(
        (f, t) => {
          let q = admin
            .from("storage_handling_events")
            .select("id, let_id, event_date, kind, amount")
            .is("billed_invoice_id", null);
          if (opts.letId) q = q.eq("let_id", opts.letId);
          return q.order("id").range(f, t);
        },
        { strict: true },
      ),
    ]);
    const [unitsRes, sitesRes] = await Promise.all([
      admin.from("storage_units").select("id, code, name, unit_type, site_id"),
      admin.from("storage_sites").select("id, name"),
    ]);
    if (unitsRes.error) throw new Error(`storage_units read failed: ${unitsRes.error.message}`);
    if (sitesRes.error) throw new Error(`storage_sites read failed: ${sitesRes.error.message}`);
    // Clients in chunks of 100 ids — same URL-length ceiling as above.
    const clients: {
      id: string;
      display_name: string | null;
      email: string | null;
      phone_e164: string | null;
      phone_raw: string | null;
      is_company: boolean | null;
      payment_terms_days: number | null;
    }[] = [];
    for (let i = 0; i < clientIds.length; i += 100) {
      const { data, error } = await admin
        .from("clients")
        // is_company + payment_terms_days: a COMPANY storage client is billed on
        // their agreed terms exactly like their removals are (PRD §3.10 — the
        // terms "apply to removals and storage invoices alike"). Reading them
        // here costs nothing: this select already runs once per billing pass.
        .select("id, display_name, email, phone_e164, phone_raw, is_company, payment_terms_days")
        .in("id", clientIds.slice(i, i + 100));
      if (error) throw new Error(`clients read failed: ${error.message}`);
      clients.push(...(data ?? []));
    }
    return {
      lets,
      invoices,
      unbilledEvents,
      units: unitsRes.data ?? [],
      clients,
      sites: sitesRes.data ?? [],
    };
  };

  let ledger: Awaited<ReturnType<typeof loadLedger>>;
  try {
    ledger = await loadLedger();
  } catch (e) {
    summary.fatal = e instanceof Error ? e.message : "ledger read failed";
    return summary;
  }
  const { lets, invoices, unbilledEvents, units, clients, sites } = ledger;
  if (!lets.length) return summary;

  const invoicedByLet = new Map<string, Set<string>>();
  for (const inv of invoices) {
    const set = invoicedByLet.get(inv.let_id) ?? new Set<string>();
    set.add(inv.period_start.slice(0, 10));
    invoicedByLet.set(inv.let_id, set);
  }
  // An event already recorded on ANY claim row (pending included) must never
  // be swept again: a claim stranded 'pending' by a write-back failure has its
  // events unmarked, and without this exclusion a same-day release would bill
  // them a second time on the final invoice.
  const claimedEventIds = new Set<string>(invoices.flatMap((i) => i.handling_event_ids ?? []));
  const eventsByLet = new Map<string, HandlingEventLite[]>();
  for (const e of unbilledEvents) {
    if (claimedEventIds.has(e.id)) continue;
    const list = eventsByLet.get(e.let_id) ?? [];
    list.push({ id: e.id, event_date: e.event_date, kind: e.kind, amount: Number(e.amount) || 0 });
    eventsByLet.set(e.let_id, list);
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const siteName = new Map<string, string>(sites.map((s) => [s.id, s.name]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  for (const let_ of lets) {
    const due = invoicesDue(let_ as BillableLet, invoicedByLet.get(let_.id) ?? new Set(), eventsByLet.get(let_.id) ?? [], today);
    if (!due.length) continue;
    const unit = unitById.get(let_.unit_id);
    const client = clientById.get(let_.client_id);
    const unitLabel = buildUnitLabel(unit, siteName);
    // Read ONCE per let, because both customer-facing halves of the invoice —
    // the ledger note and the email — have to speak as the same brand. Two
    // separate reads of the same column is how they come to disagree.
    const letBrand = (let_ as { brand?: string | null }).brand ?? null;

    for (const inv of due) {
      let claimedId: string | null = null;
      try {
        // DB claim first — a concurrent/repeat run loses the unique insert and
        // skips. The claim records EXACTLY which events it sweeps so marking
        // (and the repair sweep) never re-derive the set — a fresh computation
        // after an event delete would silently drop a charged event.
        const { data: claimed, error: claimErr } = await admin
          .from("storage_invoices")
          .insert({
            let_id: let_.id,
            client_id: let_.client_id,
            period_start: inv.period_start,
            period_end: inv.period_end,
            amount: inv.amount,
            kind: inv.kind,
            handling_amount: inv.handlingAmount,
            handling_event_ids: inv.handlingEvents.map((e) => e.id),
            status: "pending",
          } as never)
          .select("id")
          .single();
        if (claimErr || !claimed) {
          if (claimErr?.code !== "23505") summary.errors.push(`claim ${let_.id} ${inv.period_start}: ${claimErr?.message}`);
          continue;
        }
        claimedId = claimed.id;

        const reference = storageInvoiceReference(let_.id, inv.period_start);
        let ref = await findInvoiceByReference(reference); // adopt an orphan
        if (
          ref &&
          typeof ref.total === "number" &&
          classifyPendingClaim({ zohoTotal: ref.total, amount: inv.amount }) === "mismatch"
        ) {
          // The orphan's total disagrees with what this period computes —
          // adopting would link the customer to a wrong-amount invoice. Release
          // the claim and alert; this repeats daily until a human reconciles.
          const { error: delErr } = await admin
            .from("storage_invoices")
            .delete()
            .eq("id", claimed.id)
            .eq("status", "pending");
          summary.billingFailures.push(
            `Let ${let_.id.slice(0, 8)} · period ${inv.period_start} · Zoho invoice ${ref.invoiceNumber} carries our reference but totals ${gbp(ref.total)}, not the computed ${gbp(inv.amount)} — NOT adopted. Amend or void it in Zoho so billing can proceed${
              delErr ? ` · ⚠️ claim not released (${delErr.message})` : ""
            }`,
          );
          continue;
        }
        if (!ref) {
          const contactId = await findOrCreateContact({
            name: client?.display_name ?? "Storage customer",
            email: client?.email ?? null,
            phone: client?.phone_e164 ?? client?.phone_raw ?? null,
            // `storage_lets.client_id` is NOT NULL (0021_storage.sql:39), so no
            // fallback is reachable here. Note the asymmetry this buys: the
            // joined `client` row may be missing (the chunked read can miss it),
            // which is why the NAME falls back to "Storage customer" — but the
            // KEY is always sound, which is exactly the point of keying on an id.
            party: { kind: "client", id: let_.client_id },
          });
          // A COMPANY storage client is billed on the terms they agreed, the
          // same as their removals (PRD §3.10). A residential let passes
          // nothing and keeps the provider's default — storage billing is
          // otherwise untouched, cycle included.
          //
          // Resolved through the SAME helpers the removals ladder uses, so the
          // two cannot answer "what are this client's terms" differently:
          // `resolvePaymentPolicy` decides commercial-ness, `paymentTermsDays`
          // coerces a legacy null onto the allowed set, and
          // `paymentTermsDueDate` does the UK-day arithmetic.
          const storageDueDate =
            resolvePaymentPolicy(client) === "commercial"
              ? paymentTermsDueDate(new Date(), paymentTermsDays(client?.payment_terms_days))
              : null;
          // The note names a phone number and possibly a payment rail, so it
          // needs the LET's brand — the same value the email below already
          // resolves. `createInvoice` takes no brand (PRD §3.4 would give it
          // one; that is a larger seam), so the text is resolved here, before
          // it is handed over, rather than by threading a brand through the
          // ledger adapters.
          //
          // Resolved inside the try, so a brand or settings read that fails
          // releases the claim and retries next run — the file's standing rule.
          // Failing closed on card is the safe direction: a missed card
          // mention costs a phone call, an offered-but-absent one costs trust.
          //
          // `emailTheme` rather than a local read because it already answers
          // exactly the two questions the note asks — the display phone, with
          // the default brand's literal as the fallback, and whether card may
          // be named — and it is the same resolver the attached email uses two
          // steps later. Reimplementing the fallback here would put a brand
          // literal back into this file and let the note and the email drift.
          const noteTheme = emailTheme(await brandForComms(admin, letBrand ?? "marley"), {
            cardPhone: await cardPaymentsAvailable(admin, letBrand),
          });
          ref = await createInvoice({
            customerId: contactId,
            reference,
            description: invoiceDescription(
              inv,
              unitLabel,
              Number(let_.rate ?? 0),
              (let_ as { min_kind?: string | null }).min_kind,
            ),
            amount: inv.amount,
            notes: storageInvoiceNote(inv.kind, noteTheme),
            disableOnlinePayments: true, // card policy: deposit only
            itemName: "Storage", // income separation (accountant maps by item)
            ...(storageDueDate ? { dueDate: storageDueDate } : {}),
          });
        }
        // The write-back is VERIFIED. On failure the Zoho invoice EXISTS, so
        // the claim must SURVIVE (deleting it would re-raise a duplicate) —
        // the pending-claim repair completes the link next run.
        const { error: linkErr } = await admin
          .from("storage_invoices")
          .update({
            zoho_invoice_id: ref.invoiceId,
            invoice_provider: configuredProvider(),
            zoho_invoice_number: ref.invoiceNumber,
            zoho_invoice_url: ref.invoiceUrl,
            status: "sent",
          } as never)
          .eq("id", claimed.id);
        summary.raised++;
        summary.invoices.push({ letId: let_.id, invoiceNumber: ref.invoiceNumber, amount: inv.amount, kind: inv.kind });
        if (linkErr) {
          summary.billingFailures.push(
            `Let ${let_.id.slice(0, 8)} · invoice ${ref.invoiceNumber} raised in Zoho but the panel row could not be linked (${linkErr.message}) — will self-repair on the next run`,
          );
          continue; // no event marks, no email — the repair sweep completes it
        }

        // Mark swept handling events billed. A failure OR a short rowcount here
        // is a money problem (unmarked events ride the next invoice too; a
        // short count means an event was deleted mid-run after being invoiced).
        if (inv.handlingEvents.length) {
          const eventIds = inv.handlingEvents.map((e) => e.id);
          const mark = await markEventsBilled(admin, claimed.id, eventIds);
          if (mark.error) {
            summary.billingFailures.push(
              `Let ${let_.id.slice(0, 8)} · invoice ${ref.invoiceNumber} raised but handling events could NOT be marked billed (${mark.error}) — fix manually or they will bill again`,
            );
          } else if (mark.marked < eventIds.length) {
            summary.billingFailures.push(
              `Let ${let_.id.slice(0, 8)} · invoice ${ref.invoiceNumber} swept ${eventIds.length} handling event${eventIds.length === 1 ? "" : "s"} but only ${mark.marked} still existed — an event was removed mid-run or had already been billed by another invoice, so the customer may have been charged wrongly. Reconcile ${ref.invoiceNumber} in Zoho.`,
            );
          }
        }

        // Email (fail-soft — the invoice stands; Comms shows a failure).
        if (client?.email) {
          const sent = await emailStorageInvoice(admin, {
            claimId: claimed.id,
            clientEmail: client.email,
            clientName: client.display_name,
            unitLabel,
            periodLabel: periodLabelFor(inv, (let_ as { min_kind?: string | null }).min_kind),
            amount: inv.amount,
            kind: inv.kind,
            invoiceId: ref.invoiceId,
            invoiceNumber: ref.invoiceNumber,
            invoiceUrl: ref.invoiceUrl,
            letBrand,
          });
          if (sent.ok) summary.emailed++;
          else summary.errors.push(`email ${ref.invoiceNumber}: ${sent.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        summary.errors.push(`${let_.id} ${inv.period_start}: ${msg}`);
        if (!claimedId) {
          // The claim insert itself threw — nothing landed, nothing to release.
          summary.billingFailures.push(
            `Let ${let_.id.slice(0, 8)} · period ${inv.period_start} · ${msg} · nothing was claimed — retries next run`,
          );
          continue;
        }
        // RELEASE the claim so the period retries next run — do NOT leave a
        // pending/error row behind. invoicesDue() is status-agnostic (it reads
        // every storage_invoices row for the let), so a surviving claim would be
        // treated as "already billed" forever → silent under-bill. Deleting the
        // still-pending row is safe: it never carries a zoho_invoice_id (the
        // write-back runs only on success), and orphan adoption via the stable
        // MMS-<let>-<period> reference makes the re-create idempotent even if
        // Zoho did create the invoice before the failure. The .select tells us
        // whether a pending row was actually removed — 0 rows with no error
        // means the row had already reached 'sent': the invoice exists and only
        // a later step failed, so promising a retry would be a lie.
        const { data: delRows, error: delErr } = await admin
          .from("storage_invoices")
          .delete()
          .eq("id", claimedId)
          .eq("status", "pending")
          .select("id");
        const suffix = delErr
          ? ` · ⚠️ NOT released (${delErr.message}) — may not bill until fixed`
          : (delRows?.length ?? 0) > 0
            ? " · released for retry"
            : " · invoice was raised; a later step failed — no retry needed, check the invoice list";
        summary.billingFailures.push(`Let ${let_.id.slice(0, 8)} · period ${inv.period_start} · ${msg}${suffix}`);
      }
    }
  }
  return summary;
}

/**
 * Repair sweep for claims stranded 'pending' by a crash between the Zoho
 * create and the DB write-back (the one window the release-on-failure path
 * cannot cover — the process died before its catch ran). Only claims older
 * than an hour are touched so a LIVE run's fresh claim is never repaired out
 * from under it.
 *
 *  - Zoho has no invoice for the reference → the crash happened first: delete
 *    the claim so the normal engine re-raises the period next run.
 *  - Zoho invoice found and its total matches (±£0.005) → complete what the
 *    crashed run never did: write-back, mark the STORED handling events, send
 *    the customer email (deduped on emailed_at).
 *  - Totals disagree → alert and leave the claim pending — pending blocks
 *    re-raise, so there is no duplicate risk while a human reconciles.
 */
export async function repairPendingStorageClaims(
  admin: SupabaseClient,
  opts: { todayIso: string; letId?: string },
): Promise<{ adopted: number; released: number; alerts: string[] }> {
  const result = { adopted: 0, released: 0, alerts: [] as string[] };
  const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  let pendQuery = admin
    .from("storage_invoices")
    .select("id, let_id, client_id, period_start, period_end, amount, kind, handling_amount, handling_event_ids, emailed_at")
    .eq("status", "pending")
    .lt("created_at", cutoffIso);
  if (opts.letId) pendQuery = pendQuery.eq("let_id", opts.letId);
  const { data: pending, error: pendErr } = await pendQuery;
  if (pendErr) {
    result.alerts.push(`Pending-claim repair on ${opts.todayIso} could not read claims: ${pendErr.message}`);
    return result;
  }
  if (!pending?.length) return result;

  // Context for the customer email (rare path — bounded by the pending set).
  // A failed context read never blocks the write-back/marking — that is the
  // money half, and it does not need the customer's name. It DOES block the
  // email: with no let row the mail would go out worded as the default brand.
  // Holding it costs nothing, because the adopted row keeps `emailed_at is
  // null` and the un-emailed sweep is that email's retry layer.
  const letIds = [...new Set(pending.map((c) => c.let_id))];
  const clientIds = [...new Set(pending.map((c) => c.client_id).filter((id): id is string => !!id))];
  const ctx = await loadStorageEmailContext(admin, letIds, clientIds);
  if (!ctx.ok) {
    result.alerts.push(
      `Pending-claim repair: context read failed (${ctx.error}) — invoices adopted this run were NOT emailed rather than sent under the wrong brand; the un-emailed sweep re-sends them once the read recovers`,
    );
  }
  const letById = ctx.ok ? ctx.letById : new Map<string, LetContextRow>();
  const unitById = ctx.ok ? ctx.unitById : new Map<string, UnitContextRow>();
  const siteName = ctx.ok ? ctx.siteName : new Map<string, string>();
  const clientById = ctx.ok ? ctx.clientById : new Map<string, ClientContextRow>();

  for (const claim of pending) {
    const reference = storageInvoiceReference(claim.let_id, claim.period_start);
    let ref: Awaited<ReturnType<typeof findInvoiceByReference>>;
    try {
      ref = await findInvoiceByReference(reference);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      result.alerts.push(`Claim ${reference}: Zoho lookup failed (${msg}) — left pending, retried next run`);
      continue;
    }

    if (!ref) {
      const { data: del, error: delErr } = await admin
        .from("storage_invoices")
        .delete()
        .eq("id", claim.id)
        .eq("status", "pending")
        .select("id");
      if (delErr) result.alerts.push(`Claim ${reference}: could not release (${delErr.message}) — may block billing until fixed`);
      else if (del?.length) result.released++;
      continue;
    }

    if (
      typeof ref.total === "number" &&
      classifyPendingClaim({ zohoTotal: ref.total, amount: Number(claim.amount) }) === "mismatch"
    ) {
      result.alerts.push(
        `Claim ${reference}: Zoho invoice ${ref.invoiceNumber} totals ${gbp(ref.total)}, not the claimed ${gbp(Number(claim.amount))} — left pending (blocks re-raise) until a human reconciles the Zoho invoice`,
      );
      continue;
    }

    // Adopt: complete the write-back the crashed run never made.
    const { error: linkErr } = await admin
      .from("storage_invoices")
      .update({
        zoho_invoice_id: ref.invoiceId,
        invoice_provider: configuredProvider(),
        zoho_invoice_number: ref.invoiceNumber,
        zoho_invoice_url: ref.invoiceUrl,
        status: "sent",
      } as never)
      .eq("id", claim.id);
    if (linkErr) {
      result.alerts.push(
        `Claim ${reference}: invoice ${ref.invoiceNumber} exists but the panel row could not be linked (${linkErr.message}) — retried next run`,
      );
      continue;
    }
    result.adopted++;

    const eventIds = claim.handling_event_ids ?? [];
    if (eventIds.length) {
      const mark = await markEventsBilled(admin, claim.id, eventIds);
      if (mark.error) {
        result.alerts.push(
          `Claim ${reference}: handling events could NOT be marked billed (${mark.error}) — fix manually or they will bill again`,
        );
      } else if (mark.marked < eventIds.length) {
        result.alerts.push(
          `Claim ${reference}: swept ${eventIds.length} handling event${eventIds.length === 1 ? "" : "s"} but only ${mark.marked} still existed — an event was removed after invoicing, or had already been billed by another invoice. Reconcile ${ref.invoiceNumber} in Zoho.`,
        );
      }
    }

    // Customer email the crashed run never sent (deduped on emailed_at). The
    // let row is a PRECONDITION, not a nicety: it carries the brand this email
    // speaks as, and guessing it wrong is a leak that cannot be taken back.
    const client = clientById.get(claim.client_id ?? "");
    const let_ = letById.get(claim.let_id);
    if (ctx.ok && !claim.emailed_at && client?.email && !let_) {
      // The read succeeded and this ONE row was missing — the let was deleted
      // under us. A per-claim alert is right here, unlike the whole-read
      // failure already alerted once above (five copies of one outage reads as
      // five incidents and names no remedy).
      result.alerts.push(
        `Claim ${reference}: adopted, but storage let ${claim.let_id.slice(0, 8)} no longer exists, so the invoice email was held rather than sent under the wrong brand.`,
      );
    }
    if (!claim.emailed_at && client?.email && let_) {
      const kind = claim.kind as DueInvoice["kind"];
      const usage = Number(claim.amount) - Number(claim.handling_amount ?? 0);
      const days = kind === "final" && usage <= 0 ? 0 : daysInclusive(claim.period_start, claim.period_end);
      const sent = await emailStorageInvoice(admin, {
        claimId: claim.id,
        clientEmail: client.email,
        clientName: client.display_name,
        unitLabel: buildUnitLabel(unitById.get(let_.unit_id ?? ""), siteName),
        periodLabel: periodLabelFor(
          { kind, period_start: claim.period_start, period_end: claim.period_end, days },
          let_.min_kind,
        ),
        amount: Number(claim.amount),
        kind,
        invoiceId: ref.invoiceId,
        invoiceNumber: ref.invoiceNumber,
        invoiceUrl: ref.invoiceUrl,
        letBrand: let_.brand ?? null,
      });
      if (!sent.ok) result.alerts.push(`Claim ${reference}: adopted but the customer email failed (${sent.error})`);
    }
  }
  return result;
}

/**
 * Re-send storage invoices that were raised but whose email never went out.
 *
 * The invoice is created in Zoho FIRST and emailed second, and the email is
 * deliberately fail-soft (the invoice stands either way). But nothing ever
 * re-attempted it: `repairPendingStorageClaims` only looks at claims still
 * `status='pending'`, so a fully-raised invoice with `emailed_at is null` stayed
 * that way permanently. A single Resend blip at the billing hour therefore left
 * customers legally invoiced in Zoho with no invoice in their inbox — and next
 * month they receive a second bill plus a chase for one they never saw.
 *
 * Unlike customer quote mail this path does not go through dispatchComm (there
 * is no lead or quote to hang a communications row on), so this sweep IS its
 * retry layer. The `emailed_at is null` guard inside emailStorageInvoice makes a
 * double-send impossible even if two runs overlap.
 */
export async function resendUnemailedStorageInvoices(
  admin: SupabaseClient,
  opts: { todayIso: string; letId?: string },
): Promise<{ resent: number; alerts: string[] }> {
  const result = { resent: 0, alerts: [] as string[] };
  // Leave the main raise loop a window to do its own emailing before we treat a
  // row as missed.
  const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  let query = admin
    .from("storage_invoices")
    .select(
      "id, let_id, client_id, period_start, period_end, amount, kind, handling_amount, zoho_invoice_id, zoho_invoice_number, zoho_invoice_url, invoice_provider, created_at",
    )
    .eq("status", "sent")
    .is("emailed_at", null)
    .not("zoho_invoice_number", "is", null)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(50);
  if (opts.letId) query = query.eq("let_id", opts.letId);
  const { data: rows, error } = await query;
  if (error) {
    result.alerts.push(`Un-emailed storage invoice sweep could not read its rows: ${error.message}`);
    return result;
  }
  if (!rows?.length) return result;

  const letIds = [...new Set(rows.map((r) => r.let_id))];
  const clientIds = [...new Set(rows.map((r) => r.client_id).filter((id): id is string => !!id))];
  const ctx = await loadStorageEmailContext(admin, letIds, clientIds);
  if (!ctx.ok) {
    // Send NOTHING on a failed context read. This sweep's whole job is a second
    // attempt, so waiting for the next one costs a run; sending on empty maps
    // costs a customer of another brand a bill in the wrong livery they cannot
    // un-receive, and every row a "no customer email on file" claim nothing
    // checked. One alert for one outage, naming what did not happen.
    result.alerts.push(
      `Un-emailed storage invoice sweep could not read the let/customer context (${ctx.error}) — ${rows.length} invoice${rows.length === 1 ? "" : "s"} were NOT emailed this run rather than sent under the wrong brand; the next run retries them.`,
    );
    return result;
  }
  const { letById, unitById, siteName, clientById } = ctx;

  for (const row of rows) {
    const client = clientById.get(row.client_id ?? "");
    if (!client?.email) {
      // No address to send to — surface once rather than sweeping it forever.
      // Truthful only because the read above is checked: on a failed clients
      // read this said the same thing about every row, having checked nothing.
      result.alerts.push(
        `Storage invoice ${row.zoho_invoice_number} has no customer email on file — send it by hand from Zoho.`,
      );
      continue;
    }
    const let_ = letById.get(row.let_id);
    if (!let_) {
      // The read succeeded, so this let has been deleted. Its brand is now
      // unknowable, and an invoice email worded as the wrong company is worse
      // than one sent by hand.
      result.alerts.push(
        `Storage invoice ${row.zoho_invoice_number}: storage let ${row.let_id.slice(0, 8)} no longer exists, so its brand cannot be resolved — not emailed. Send it by hand from Zoho.`,
      );
      continue;
    }
    const kind = row.kind as DueInvoice["kind"];
    const usage = Number(row.amount) - Number(row.handling_amount ?? 0);
    const days = kind === "final" && usage <= 0 ? 0 : daysInclusive(row.period_start, row.period_end);
    const unit = unitById.get(let_.unit_id ?? "");
    const sent = await emailStorageInvoice(admin, {
      claimId: row.id,
      clientEmail: client.email,
      clientName: client.display_name,
      unitLabel: buildUnitLabel(unit, siteName),
      periodLabel: periodLabelFor(
        { kind, period_start: row.period_start, period_end: row.period_end, days },
        let_.min_kind,
      ),
      amount: Number(row.amount),
      kind,
      invoiceId: row.zoho_invoice_id as string,
      invoiceProvider: row.invoice_provider as string | null,
      invoiceNumber: row.zoho_invoice_number as string,
      invoiceUrl: row.zoho_invoice_url as string | null,
      letBrand: let_.brand ?? null,
    });
    if (sent.ok) result.resent++;
    else {
      result.alerts.push(
        `Storage invoice ${row.zoho_invoice_number} still could not be emailed to ${client.email} (${sent.error}) — the customer has been billed but has no copy.`,
      );
    }
  }
  return result;
}
