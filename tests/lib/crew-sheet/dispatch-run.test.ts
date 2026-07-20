import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub the low-level senders so the run doesn't hit Resend/WebEx. The PDF render
// is left real — it exercises the server printer end-to-end.
const sent: { email: number; sms: number } = { email: 0, sms: 0 };
const sendCtl = { fail: false }; // flip to simulate a dropped/failed send
vi.mock("@/lib/comms/send", () => ({
  sendEmail: vi.fn(async () => {
    if (sendCtl.fail) return { ok: false, error: "no signal" };
    sent.email++;
    return { ok: true, providerId: "email-x" };
  }),
  sendSms: vi.fn(async () => {
    if (sendCtl.fail) return { ok: false, error: "no signal" };
    sent.sms++;
    return { ok: true, providerId: "sms-x" };
  }),
}));

import { dispatchCrewJobSheets } from "@/lib/crew-sheet/dispatch";

const NOW = new Date("2026-07-21T09:00:00Z"); // 10:00 UK on 21 Jul → today's window open

const LEAD = {
  id: "L1",
  name: "Jane Doe",
  phone: "07711 111111",
  from_address: "1 A St",
  from_postcode: "SP7 8AA",
  to_address: "2 B St",
  to_postcode: "BH1 1BB",
  notes: "Ring the buzzer",
};

/* Stateful in-memory admin: canned read tables + a live crew_job_sheets /
 * crew_job_sheet_sends store, enough for the create/deliver/supersede cycle. */
function memAdmin(canned: Record<string, unknown[]>) {
  const sheets: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sends: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let seq = 0;

  const from = (table: string) => {
    let op = "select";
    let payload: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    let ignoreDup = false;
    const filters: [string, unknown][] = [];
    const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const m of ["select", "neq", "in", "gte", "lt", "order", "limit", "maybeSingle"]) q[m] = () => q;
    q.eq = (c: string, v: unknown) => (filters.push([c, v]), q);
    q.upsert = (obj: any, opts: any) => ((op = "upsert"), (payload = obj), (ignoreDup = !!opts?.ignoreDuplicates), q); // eslint-disable-line @typescript-eslint/no-explicit-any
    q.update = (p: any) => ((op = "update"), (payload = p), q); // eslint-disable-line @typescript-eslint/no-explicit-any
    q.insert = (rows: any) => ((op = "insert"), (payload = rows), q); // eslint-disable-line @typescript-eslint/no-explicit-any
    const match = (row: any) => filters.every(([c, v]) => row[c] === v); // eslint-disable-line @typescript-eslint/no-explicit-any
    q.then = (resolve: (v: { data: unknown[] | null }) => void) => {
      if (table === "crew_job_sheets") {
        if (op === "select") return resolve({ data: sheets.filter(match) });
        if (op === "upsert") {
          const exists = sheets.find((s) => s.staff_id === payload.staff_id && s.work_date === payload.work_date);
          if (exists && ignoreDup) return resolve({ data: [] });
          const row = {
            id: `sheet${++seq}`,
            version: 1,
            content_hash: payload.content_hash,
            delivered_hash: null,
            delivered_at: null,
            attempts: payload.attempts ?? 0,
            token: payload.token,
            staff_id: payload.staff_id,
            work_date: payload.work_date,
          };
          sheets.push(row);
          return resolve({ data: [row] });
        }
        if (op === "update") {
          const hit = sheets.filter(match);
          hit.forEach((r) => Object.assign(r, payload));
          return resolve({ data: hit });
        }
      }
      if (table === "crew_job_sheet_sends") {
        if (op === "insert") {
          for (const r of payload) sends.push(r);
          return resolve({ data: payload });
        }
        return resolve({ data: sends.filter(match) });
      }
      return resolve({ data: canned[table] ?? [] });
    };
    return q;
  };

  return { admin: { from }, sheets, sends };
}

function canned() {
  return {
    appointments: [
      {
        id: "a1",
        title: "Job",
        starts_at: "2026-07-21T08:00:00Z",
        ends_at: "2026-07-21T12:00:00Z",
        all_day: false,
        appt_type: "removal",
        lead_id: "L1",
        status: "scheduled",
      },
    ],
    appointment_assignments: [{ appointment_id: "a1", staff_id: "s1", vehicle_id: "v1" }],
    leads: [LEAD],
    quotes: [],
    staff: [{ id: "s1", full_name: "Rob Pierce", email: "rob@x.com", phone: "07700900123", is_active: true }],
    vehicles: [{ id: "v1", name: "Luton 1", registration: "AB12 CDE" }],
  };
}

describe("dispatchCrewJobSheets — full cycle", () => {
  beforeEach(() => {
    sent.email = 0;
    sent.sms = 0;
    sendCtl.fail = false;
  });

  it("sends once, then is idempotent, then supersedes on a change", async () => {
    const data = canned();
    const { admin, sheets, sends } = memAdmin(data);

    // ── Pass 1: initial send ────────────────────────────────────────────────
    const r1 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r1.sent).toBe(1);
    expect(r1.emailOk).toBe(1);
    expect(r1.smsOk).toBe(1);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].version).toBe(1);
    expect(sheets[0].delivered_hash).toBe(sheets[0].content_hash); // marked delivered
    const emailSend = sends.find((s) => s.channel === "email");
    expect(emailSend.status).toBe("sent");
    expect(emailSend.superseding).toBe(false);
    expect(sent.email).toBe(1);
    expect(sent.sms).toBe(1);

    // ── Pass 2: nothing changed → no re-send ────────────────────────────────
    const r2 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r2.sent).toBe(0);
    expect(sent.email).toBe(1); // unchanged
    expect(sends.filter((s) => s.channel === "email")).toHaveLength(1);
    expect(sheets[0].version).toBe(1);

    // ── Pass 3: a job detail changes → superseding re-send ──────────────────
    data.leads[0].notes = "Ring the buzzer TWICE — dog in the garden";
    const r3 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r3.sent).toBe(1);
    expect(sheets[0].version).toBe(2);
    const supersede = sends.filter((s) => s.superseding === true);
    expect(supersede.length).toBeGreaterThanOrEqual(1);
    expect(sent.email).toBe(2);

    // ── Pass 4: settled again → idempotent ──────────────────────────────────
    const r4 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r4.sent).toBe(0);
    expect(sent.email).toBe(2);
  });

  it("does not send before the 18:00 window when nothing is booked for today", async () => {
    // now = 2026-07-20 12:00 UTC → today 20 Jul (no appts), tomorrow 21 Jul
    // (has the appt, but the window for 21 Jul opens at 18:00 on the 20th).
    const early = new Date("2026-07-20T12:00:00Z");
    const { admin, sheets } = memAdmin(canned());
    const r = await dispatchCrewJobSheets(admin as never, early);
    expect(r.sent).toBe(0);
    expect(sheets).toHaveLength(0); // no row created before the window
  });

  it("retries a failed send on the next pass and only counts the delivery once", async () => {
    const { admin, sheets } = memAdmin(canned());

    // Pass 1: both channels fail (dropped signal) — row created, nothing delivered.
    sendCtl.fail = true;
    const r1 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r1.sent).toBe(0);
    expect(sheets[0].delivered_hash).toBeNull();
    expect(sheets[0].attempts).toBe(1);
    expect(sheets[0].version).toBe(1);

    // Pass 2: signal is back — the retry path claims + re-sends, now delivered.
    sendCtl.fail = false;
    const r2 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r2.sent).toBe(1);
    expect(sheets[0].delivered_hash).toBe(sheets[0].content_hash);
    expect(sheets[0].version).toBe(1); // a retry is NOT a new version
    expect(sent.email).toBe(1); // delivered exactly once, not on the failed pass

    // Pass 3: settled → no further send.
    const r3 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r3.sent).toBe(0);
    expect(sent.email).toBe(1);
  });

  it("a crew member with no email or phone is surfaced once and not retried every pass", async () => {
    const data = canned();
    data.staff = [{ id: "s1", full_name: "Rob Pierce", email: null, phone: null, is_active: true }] as unknown as typeof data.staff;
    const { admin, sheets, sends } = memAdmin(data);

    const r1 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r1.skippedNoContact).toBe(1);
    expect(r1.failures.some((f) => f.channel === "none")).toBe(true);
    expect(sheets[0].attempts).toBe(6); // marked terminal — no more retries

    const sendsAfter1 = sends.length;
    const r2 = await dispatchCrewJobSheets(admin as never, NOW);
    expect(r2.skippedNoContact).toBe(0); // decideSheetAction → done, not reprocessed
    expect(sends.length).toBe(sendsAfter1); // no new skipped rows logged
  });
});
