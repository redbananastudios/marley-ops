import { describe, expect, it } from "vitest";
import {
  dueReminders,
  isoWeek,
  overdueThreshold,
  type FleetVehicle,
  type ReminderLogRow,
} from "@/lib/fleet/reminders";

// Fixed "today" — 9 July 2026 (UK summer). Dates below are chosen relative to it.
const TODAY = new Date("2026-07-09T12:00:00Z");

const van = (over: Partial<FleetVehicle> = {}): FleetVehicle => ({
  id: "v1",
  name: "Luton 1",
  tax_due: null,
  mot_due: null,
  insurance_renewal: null,
  service_due: null,
  end_of_term: null,
  ...over,
});
const log = (rows: Partial<ReminderLogRow>[]): ReminderLogRow[] =>
  rows.map((r) => ({ vehicle_id: "v1", expiry_type: "mot_due", due_date: "2026-08-06", threshold: "28", ...r }));

describe("dueReminders", () => {
  it("is empty with nothing set", () => {
    expect(dueReminders([van()], TODAY, [])).toEqual([]);
  });

  it("fires nothing when the expiry is further out than 28 days", () => {
    expect(dueReminders([van({ mot_due: "2026-08-07" })], TODAY, [])).toEqual([]); // 29 days
  });

  it("fires the 28-day bucket as it is crossed", () => {
    const due = dueReminders([van({ mot_due: "2026-08-06" })], TODAY, []); // exactly 28 days
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ expiry_type: "mot_due", threshold: "28", days: 28, record: ["28"] });
  });

  it("fires 14 once 28 is already logged", () => {
    const due = dueReminders([van({ mot_due: "2026-07-23" })], TODAY, log([{ threshold: "28", due_date: "2026-07-23" }]));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ threshold: "14", days: 14, record: ["14"] });
  });

  it("fires the day-of (0) bucket when the looser ones are logged", () => {
    const due = dueReminders(
      [van({ mot_due: "2026-07-09" })],
      TODAY,
      log([28, 14, 7, 3].map((t) => ({ threshold: String(t), due_date: "2026-07-09" }))),
    );
    expect(due[0]).toMatchObject({ threshold: "0", days: 0, record: ["0"] });
  });

  it("a late-entered date fires ONCE (tightest bucket) and suppresses the missed ones", () => {
    const due = dueReminders([van({ mot_due: "2026-07-14" })], TODAY, []); // 5 days out, no history
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ threshold: "7", days: 5 });
    expect(due[0].record).toEqual(["28", "14", "7"]);
  });

  it("is empty when every crossed bucket is already logged", () => {
    const due = dueReminders(
      [van({ mot_due: "2026-07-14" })],
      TODAY,
      log([28, 14, 7].map((t) => ({ threshold: String(t), due_date: "2026-07-14" }))),
    );
    expect(due).toEqual([]);
  });

  it("fires a weekly overdue alert, keyed by ISO week", () => {
    const due = dueReminders([van({ mot_due: "2026-07-01" })], TODAY, []); // 8 days overdue
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ threshold: overdueThreshold(TODAY), days: -8 });
    expect(due[0].record).toEqual([overdueThreshold(TODAY)]);
  });

  it("does not repeat the overdue alert within the same week", () => {
    const due = dueReminders(
      [van({ mot_due: "2026-07-01" })],
      TODAY,
      log([{ threshold: overdueThreshold(TODAY), due_date: "2026-07-01" }]),
    );
    expect(due).toEqual([]);
  });

  it("re-fires the overdue alert the following week", () => {
    const nextWeek = new Date("2026-07-16T12:00:00Z");
    expect(overdueThreshold(nextWeek)).not.toBe(overdueThreshold(TODAY));
    const due = dueReminders(
      [van({ mot_due: "2026-07-01" })],
      nextWeek,
      log([{ threshold: overdueThreshold(TODAY), due_date: "2026-07-01" }]),
    );
    expect(due).toHaveLength(1);
    expect(due[0].threshold).toBe(overdueThreshold(nextWeek));
  });

  it("a renewed date (new due_date) is not blocked by the old cycle's log", () => {
    const due = dueReminders(
      [van({ mot_due: "2026-08-06" })], // renewed, 28 days out
      TODAY,
      log([{ threshold: "28", due_date: "2025-08-06" }]), // last year's cycle
    );
    expect(due).toHaveLength(1);
    expect(due[0].threshold).toBe("28");
  });

  it("reports each approaching expiry independently", () => {
    const due = dueReminders([van({ mot_due: "2026-08-06", insurance_renewal: "2026-07-23" })], TODAY, []);
    expect(due.map((d) => d.expiry_type).sort()).toEqual(["insurance_renewal", "mot_due"]);
  });

  it("isoWeek returns an ISO-8601 week label", () => {
    expect(isoWeek(TODAY)).toMatch(/^\d{4}-W\d{2}$/);
  });
});
