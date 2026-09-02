import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBookingRows, removalCompleted, ukDayOfInstant } from "@/lib/bookings/load-signals";
import { fakePostgrest } from "./fake-postgrest";

/**
 * "Is the job done" on a multi-day removal.
 *
 * `jobCompleted` used to be read off the EARLIEST removal appointment, because
 * that is the entry already looked up for the move date. The two questions are
 * not the same one: a two-day job crewed Friday and Saturday flips its Friday
 * entry to 'completed' at Friday's sign-off, so on Friday evening /bookings read
 * "completed — raise the invoice" for a job with a van still going out in the
 * morning. On a commercial booking that is the trigger for the invoice itself.
 *
 * Multiple live removals on one lead are ordinary rather than exotic: the manual
 * createAppointment path has no duplicate guard.
 */
describe("removalCompleted", () => {
  it("a two-day job is NOT done when the first day is signed off and the second is not", () => {
    // The exact Friday-evening shape, in query order (earliest first) — which
    // is what made reading the first entry look right.
    expect(
      removalCompleted([{ status: "completed" }, { status: "scheduled" }]),
    ).toBe(false);
  });

  it("is done once every removal day is signed off", () => {
    expect(removalCompleted([{ status: "completed" }, { status: "completed" }])).toBe(true);
    expect(removalCompleted([{ status: "completed" }])).toBe(true);
  });

  it("out-of-order sign-off reads as NOT done, which is the safe direction", () => {
    // Saturday closed, Friday forgotten. Asking only about the LATEST entry
    // would call this finished; asking whether anything is still outstanding
    // parks it in "awaiting completion" where the office can see it. Delaying
    // an invoice is visible; invoicing a job that is still running is not.
    expect(removalCompleted([{ status: "scheduled" }, { status: "completed" }])).toBe(false);
  });

  it("a single unfinished day is not done", () => {
    expect(removalCompleted([{ status: "scheduled" }])).toBe(false);
  });

  it("a lead with no removal appointment at all has not completed anything", () => {
    // `every` is vacuously true on an empty list, so without the length guard a
    // booking with nothing in the diary would report itself finished — and a
    // commercial one would invite an invoice for a job never carried out.
    expect(removalCompleted([])).toBe(false);
  });

  it("an unknown status is not a completion", () => {
    expect(removalCompleted([{ status: null }])).toBe(false);
    expect(removalCompleted([{ status: "completed" }, { status: null }])).toBe(false);
  });
});

/**
 * The wiring. `removalCompleted` is only an answer if the loader asks it — and
 * the single-appointment read it replaces is one line, easy to reintroduce
 * while the diary lookup beside it still legitimately wants the earliest slot.
 */
describe("loadBookingRows asks the whole diary, not the first slot", () => {
  const src = readFileSync(join(process.cwd(), "lib/bookings/load-signals.ts"), "utf8");

  it("answers jobCompleted from every removal appointment on the lead", () => {
    expect(src).toContain("jobCompleted: removalCompleted(");
    expect(src).not.toContain('appt?.status === "completed"');
  });

  it("still keeps the EARLIEST appointment for the move date itself", () => {
    // The fix must not swap which slot the board shows or which entry the
    // change-date dialog opens — that would move residential move dates.
    expect(src).toContain("apptStartsAt: appt?.startsAt ?? null");
    expect(src).toContain("(a.starts_at as string) < cur.startsAt");
  });
});

/**
 * Who is allowed to be lied to by a failed read.
 *
 * Every read under this loader fail-softs: `fetchAllRows` logs the window and
 * breaks, and the secondary reads destructure only `data`. That is the right
 * answer for /bookings and /payments — the office would rather see the newest
 * rows and reload than meet a 500 — but it is the wrong answer for a caller
 * that DECIDES on the absence of rows. `sweepCommercialOverdue` resolves both
 * commercial alarms when the list comes back empty, so an empty list it never
 * actually received clears a live credit-control alarm and reports the sweep
 * clean.
 *
 * `strict` is that caller's contract, and both halves have to be pinned: the
 * strict path must THROW on a failed read, and the default path must still
 * render, or the fix quietly turns every page into a 500 the first time one
 * secondary read errors.
 */
describe("loadBookingRows: a failed read is only allowed to fail soft", () => {
  const QUOTE = {
    id: "q-1",
    quote_ref: "MMC900",
    source: "ops",
    status: "accepted",
    payment_policy: "commercial",
    commercial_due_date: "2026-08-01",
    lead_id: "l-1",
    customer_name: "Pitmans Ltd",
    customer_email: "accounts@pitmans.example",
    customer_phone: null,
    agreed_price: 1200,
    grand_total: 1200,
    accepted_at: "2026-07-01T09:00:00Z",
    accept_token: "tok",
    moving_date: "2026-07-20",
    deposit_amount: 0,
    deposit_paid_at: null,
    deposit_selfreport_at: null,
    commitment_paid_at: null,
    commitment_invoice_amount: 0,
    commitment_due_date: null,
    date_releasable_at: null,
    zoho_balance_invoice_id: null,
    zoho_balance_invoice_number: null,
    balance_invoice_amount: 1200,
    booking_cancelled_at: null,
  };
  const LEAD = {
    id: "l-1",
    name: "Pitmans Ltd",
    status: "confirmed",
    preferred_date: null,
    chase_paused: false,
    deposit_chase_step: 0,
    balance_paid_at: null,
    date_confirmed_at: null,
  };
  const ok = { data: [] as unknown, error: null };

  it("strict: a PostgREST error on the driving quotes read throws", async () => {
    // The reachable trigger this was written for: a deploy landing before
    // PostgREST reloads the schema cache errors the window that names
    // `commercial_due_date`. Without strict, fetchAllRows breaks and the ledger
    // arrives as [].
    const sb = fakePostgrest({
      business_settings: { data: null, error: null },
      quotes: { data: null, error: { message: "column quotes.commercial_due_date does not exist" } },
    });

    await expect(loadBookingRows(sb, { strict: true })).rejects.toThrow(/commercial_due_date/);
  });

  it("strict: an errored leads read throws rather than emptying the ledger", async () => {
    // The quieter half. supabase-js resolves with {data:null,error}, so a null
    // `leads` empties leadById and EVERY quote hits the `continue` — a full
    // ledger of accepted bookings arrives as zero rows with nothing thrown.
    const sb = fakePostgrest({
      business_settings: { data: null, error: null },
      quotes: { data: [QUOTE], error: null },
      leads: { data: null, error: { message: "permission denied for table leads" } },
    });

    await expect(loadBookingRows(sb, { strict: true })).rejects.toThrow(/permission denied/);
  });

  it("by default a page still renders what it has — the fail-soft is deliberate", async () => {
    // /bookings, /payments and the dashboard tiles all read this loader without
    // strict ON PURPOSE. A secondary read failing must cost them a chip, not
    // the page: this booking has no booking_details row to show, and still
    // renders with its money intact.
    const sb = fakePostgrest({
      business_settings: { data: null, error: null },
      quotes: { data: [QUOTE], error: null },
      leads: { data: [LEAD], error: null },
      appointments: ok,
      booking_details: { data: null, error: { message: "statement timeout" } },
    });

    const { rows } = await loadBookingRows(sb);

    expect(rows).toHaveLength(1);
    expect(rows[0].quoteRef).toBe("MMC900");
    expect(rows[0].approxWindow).toBeNull();
  });

  it("by default a failed quotes read is still an empty ledger, not a throw", async () => {
    // Named explicitly so nobody "fixes" this into a throw for every caller.
    // The page's contract is unchanged; only strict callers moved.
    const sb = fakePostgrest({
      business_settings: { data: null, error: null },
      quotes: { data: null, error: { message: "boom" } },
    });

    await expect(loadBookingRows(sb)).resolves.toMatchObject({ rows: [] });
  });
});

describe("ukDayOfInstant", () => {
  it("buckets an all-day BST move by its London day, not the UTC slice", () => {
    // A Monday all-day move during BST is stored 23:00Z on the Sunday.
    expect(ukDayOfInstant("2026-08-16T23:00:00Z")).toBe("2026-08-17");
  });
});
