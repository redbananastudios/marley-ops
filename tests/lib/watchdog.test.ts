import { describe, expect, it } from "vitest";
import { alertsAlreadySent, feedStalenessAlert, findOverdueJobs } from "@/lib/watchdog-rules";
import { CRON_JOBS } from "@/lib/cron/jobs";

const NOW = new Date("2026-07-16T18:00:00Z");

/** Fresh timestamps for every registered job. */
const allFresh = (): Record<string, string> =>
  Object.fromEntries(CRON_JOBS.map((j) => [j.slug, "2026-07-16T17:59:00Z"]));

describe("findOverdueJobs", () => {
  it("all fresh → no alerts", () => {
    expect(findOverdueJobs(allFresh(), NOW)).toEqual([]);
  });

  it("a 2-min job silent past its window alerts with a minutes label", () => {
    const ok = allFresh();
    ok["bank-feed"] = "2026-07-16T17:30:00Z"; // 30m > 15m window
    const alerts = findOverdueJobs(ok, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe("overdue:bank-feed");
    expect(alerts[0].message).toContain("30m");
  });

  it("a daily job inside its 26h window stays quiet; past it alerts in hours", () => {
    const ok = allFresh();
    ok["chase"] = "2026-07-15T20:00:00Z"; // 22h — fine
    expect(findOverdueJobs(ok, NOW)).toEqual([]);
    ok["chase"] = "2026-07-15T10:00:00Z"; // 32h — overdue
    const alerts = findOverdueJobs(ok, NOW);
    expect(alerts[0].key).toBe("overdue:chase");
    expect(alerts[0].message).toContain("32h");
  });

  it("a job that has never run alerts", () => {
    const ok = allFresh();
    delete ok["card-reconcile"];
    const alerts = findOverdueJobs(ok, NOW);
    expect(alerts[0].key).toBe("never:card-reconcile");
  });

  it("never checks itself (no recursion alert)", () => {
    const keys = findOverdueJobs({}, NOW).map((a) => a.key);
    expect(keys).not.toContain("never:health-watchdog");
  });
});

describe("feedStalenessAlert", () => {
  it("quiet under 72h or unconfigured → null", () => {
    expect(feedStalenessAlert("2026-07-15T18:00:00Z", true, NOW)).toBeNull(); // 24h
    expect(feedStalenessAlert("2026-07-10T18:00:00Z", false, NOW)).toBeNull();
    expect(feedStalenessAlert(null, true, NOW)).toBeNull();
  });

  it("beyond 72h of silence alerts", () => {
    const a = feedStalenessAlert("2026-07-12T18:00:00Z", true, NOW); // 96h
    expect(a?.key).toBe("feed-stale");
    expect(a?.message).toContain("96h");
  });
});

describe("alertsAlreadySent (6h cooldown)", () => {
  const alert = { key: "overdue:chase", message: "x" };

  it("no alerts → nothing to send", () => {
    expect(alertsAlreadySent([], [])).toBe(true);
  });

  it("fresh alert with no recent sends → send", () => {
    expect(alertsAlreadySent([alert], [])).toBe(false);
    expect(alertsAlreadySent([alert], [{ alerts: [alert], smsSent: false }])).toBe(false);
  });

  it("identical alert already SMS'd → cooldown holds", () => {
    expect(alertsAlreadySent([alert], [{ alerts: [alert], smsSent: true }])).toBe(true);
  });

  it("a NEW alert joining an already-sent one re-pages immediately", () => {
    const grown = [alert, { key: "feed-stale", message: "y" }];
    expect(alertsAlreadySent(grown, [{ alerts: [alert], smsSent: true }])).toBe(false);
  });
});
