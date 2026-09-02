import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The books lock-out alert is SHARED across providers (gate 18 funnels Xero
 * failures into the same module the 2026-08-27 Zoho lock-out built), so the
 * remedy it names must be the remedy for the provider that actually failed.
 * Telling the office to "re-enable the ops user in Zoho" while Xero has a dead
 * refresh token sends a human to the wrong system with a clear conscience.
 *
 * Dedup is one key PER PROVIDER: an integration is a provider connection, so
 * "one broken integration = one alarm" holds per provider — and, critically,
 * resolving on a green probe of one provider can never clear the other's red
 * (the watchdog side of that contract is pinned in watchdog-probe.test.ts).
 */

const issues = vi.hoisted(() => ({
  reportOperationalIssue: vi.fn<(sb: unknown, issue: Record<string, unknown>) => Promise<void>>(
    async () => {},
  ),
  resolveOperationalIssue: vi.fn<(sb: unknown, key: string) => Promise<void>>(async () => {}),
}));
const dispatch = vi.hoisted(() => ({
  sendOpsAlert: vi.fn<(subject: string, paragraphs: string[], category: string) => Promise<boolean>>(
    async () => true,
  ),
}));

vi.mock("@/lib/ops/issues", () => issues);
vi.mock("@/lib/comms/dispatch", () => dispatch);

import {
  ledgerAccessIssueKey,
  reportLedgerAccessDenied,
  resolveLedgerAccessDenied,
} from "@/lib/ops/zoho-access";

const sb = {} as never;

beforeEach(() => {
  issues.reportOperationalIssue.mockClear();
  issues.resolveOperationalIssue.mockClear();
  dispatch.sendOpsAlert.mockClear();
});

describe("ledgerAccessIssueKey", () => {
  it("keeps Zoho's historical key byte-identical (an open prod issue must still resolve)", () => {
    expect(ledgerAccessIssueKey("zoho")).toBe("zoho:access-denied");
  });

  it("gives Xero its own key — a Zoho green must have nothing it can clear for Xero", () => {
    expect(ledgerAccessIssueKey("xero")).toBe("xero:access-denied");
  });
});

describe("reportLedgerAccessDenied — zoho (byte-identical to today)", () => {
  it("raises the same issue and the same email the 2026-08-27 fix shipped", async () => {
    await reportLedgerAccessDenied(sb, {
      provider: "zoho",
      message: "You do not have access as your account is disabled.",
      while: "deposit invoice",
    });

    expect(issues.reportOperationalIssue).toHaveBeenCalledTimes(1);
    const issue = issues.reportOperationalIssue.mock.calls[0][1] as Record<string, unknown>;
    expect(issue.key).toBe("zoho:access-denied");
    expect(issue.severity).toBe("critical");
    expect(issue.source).toBe("zoho");
    expect(issue.event).toBe("zoho.access_denied");
    expect(issue.message).toBe(
      "Zoho has locked the ops integration out — invoices and payment checks are failing.",
    );

    expect(dispatch.sendOpsAlert).toHaveBeenCalledTimes(1);
    const [subject, paragraphs, category] = dispatch.sendOpsAlert.mock.calls[0] as unknown as [
      string,
      string[],
      string,
    ];
    expect(subject).toBe("Zoho access denied — the books integration is locked out");
    expect(paragraphs).toEqual([
      "Ops can no longer read or write anything in Zoho, so deposit, commitment and balance invoices are not being raised and payments recorded in Zoho are not reaching ops.",
      "<strong>Fix:</strong> a Zoho admin on the MarleyMoves Ltd org opens Settings &rarr; Users &amp; Roles and marks the ops integration user <strong>Active</strong> again (its status is currently Inactive).",
      "Nothing needs replaying afterwards — every invoice retries itself on the next pass, and affected quotes keep their own error on the quote record.",
    ]);
    expect(category).toBe("system");
  });

  it("carries the provider on the issue context", async () => {
    await reportLedgerAccessDenied(sb, { provider: "zoho", message: "x", while: "payment watch" });
    const issue = issues.reportOperationalIssue.mock.calls[0][1] as { context: Record<string, unknown> };
    expect(issue.context.provider).toBe("zoho");
    expect(issue.context.failedWhile).toBe("payment watch");
  });
});

describe("reportLedgerAccessDenied — xero (its own remedy, never Zoho's)", () => {
  it("names the Xero re-auth path, not Zoho's Users & Roles screen", async () => {
    await reportLedgerAccessDenied(sb, {
      provider: "xero",
      message: "Xero token request failed: invalid_grant",
      while: "deposit invoice",
    });

    const issue = issues.reportOperationalIssue.mock.calls[0][1] as Record<string, unknown>;
    expect(issue.key).toBe("xero:access-denied");
    expect(issue.severity).toBe("critical");
    expect(issue.source).toBe("xero");
    expect(issue.event).toBe("xero.access_denied");
    expect(issue.message).toBe(
      "Xero has locked the ops integration out — invoices and payment checks are failing.",
    );
    expect((issue.context as Record<string, unknown>).provider).toBe("xero");

    const [subject, paragraphs] = dispatch.sendOpsAlert.mock.calls[0] as unknown as [string, string[]];
    expect(subject).toBe("Xero access denied — the books integration is locked out");
    const body = paragraphs.join(" ");
    expect(body).toContain("/api/xero/connect");
    // The wrong remedy is worse than no remedy: nothing in the Xero alert may
    // send a human into Zoho's user screen.
    expect(subject).not.toMatch(/zoho/i);
    expect(body).not.toMatch(/zoho/i);
    expect(body).not.toContain("Users &amp; Roles");
  });

  it("keeps the email body input-independent so the provider-side content hash still dedups", async () => {
    await reportLedgerAccessDenied(sb, { provider: "xero", message: "first failure", while: "deposit invoice" });
    await reportLedgerAccessDenied(sb, { provider: "xero", message: "different failure", while: "payment watch" });
    const [first, second] = dispatch.sendOpsAlert.mock.calls;
    expect(second).toEqual(first);
  });
});

describe("resolveLedgerAccessDenied — scoped to the provider that went green", () => {
  it("a zoho resolve touches only zoho's key", async () => {
    await resolveLedgerAccessDenied(sb, "zoho");
    expect(issues.resolveOperationalIssue).toHaveBeenCalledTimes(1);
    expect(issues.resolveOperationalIssue).toHaveBeenCalledWith(sb, "zoho:access-denied");
  });

  it("a xero resolve touches only xero's key", async () => {
    await resolveLedgerAccessDenied(sb, "xero");
    expect(issues.resolveOperationalIssue).toHaveBeenCalledTimes(1);
    expect(issues.resolveOperationalIssue).toHaveBeenCalledWith(sb, "xero:access-denied");
  });
});
