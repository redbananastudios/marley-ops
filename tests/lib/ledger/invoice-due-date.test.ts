import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate 10b — a commercial invoice states its due date ON THE DOCUMENT.
 *
 * `quotes.commercial_due_date` drives our own /bookings overdue state and the
 * ops alarm, and until now that is ALL it did. The invoice actually sent to the
 * client carried no due date at all, in either ledger — so the one party who
 * has to act on the terms could not see them, and the provider's own `overdue`
 * status could never fire either (lib/ledger/types.ts documented exactly that).
 *
 * The failure mode this guards is not a wrong date; it is a DROPPED one. A due
 * date threaded through the contract but omitted from one adapter's payload
 * fails nothing, throws nothing, and produces an invoice that looks completely
 * normal — while the terms silently do not exist on the document. Both adapters
 * are asserted, and so is the omit-when-absent branch that keeps every
 * residential invoice byte-identical.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const TYPES = read("lib/ledger/types.ts");
const ZOHO = read("lib/zoho.ts");
const XERO = read("lib/ledger/xero-invoices.ts");
const FLOW = read("lib/quote/accept-flow.ts");
const STORAGE = read("lib/storage/raise-storage-invoices.ts");

describe("the ledger contract carries a due date", () => {
  it("declares it optional, so every existing caller is unchanged", () => {
    expect(TYPES).toContain("dueDate?: string;");
  });

  it("no longer claims createInvoice cannot set one", () => {
    // The old comment ("which `createInvoice` does not yet set") was true and
    // is now false. A stale comment that describes a limitation which has been
    // lifted is worse than none: the next reader designs around it.
    expect(TYPES).not.toContain("which `createInvoice` does not yet set");
  });
});

describe("both adapters actually send it", () => {
  it("Zoho puts it in the invoice payload", () => {
    expect(ZOHO).toContain("...(input.dueDate ? { due_date: input.dueDate } : {}),");
  });

  it("Xero puts it in the invoice payload", () => {
    expect(XERO).toContain("...(input.dueDate ? { DueDate: input.dueDate } : {}),");
  });

  it("both OMIT the field when no caller passes one", () => {
    // Spreading `{ due_date: undefined }` is not the same as omitting the key:
    // it serialises, and a provider that reads a present-but-null due date can
    // behave differently from one that never saw the field. The conditional
    // spread is what keeps a residential raise identical to before.
    for (const [name, src, key] of [
      ["Zoho", ZOHO, "due_date"],
      ["Xero", XERO, "DueDate"],
    ] as const) {
      expect(src, `${name} must spread ${key} conditionally, never unconditionally`).not.toMatch(
        new RegExp(`\\n\\s*${key}: input\\.dueDate,`),
      );
    }
  });
});

describe("the callers pass the client's agreed terms", () => {
  it("the removals completion invoice passes the commercial terms date", () => {
    expect(FLOW).toContain("...(commercialDueDate ? { dueDate: commercialDueDate } : {}),");
  });

  it("computes that date BEFORE the invoice is created, not after", () => {
    // tsc caught this on the first attempt — the computation sat below the
    // createInvoice call, so the reference was a temporal-dead-zone error. It
    // is asserted rather than left to the compiler because the failure if the
    // binding were ever made `var`-like or hoisted differently is a silently
    // undefined due date, not a crash.
    const computed = FLOW.indexOf("const commercialDueDate =");
    const used = FLOW.indexOf("...(commercialDueDate ? { dueDate: commercialDueDate } : {}),");
    expect(computed, "commercialDueDate is no longer computed").toBeGreaterThan(-1);
    expect(used, "the completion invoice no longer passes a due date").toBeGreaterThan(-1);
    expect(computed).toBeLessThan(used);
  });

  it("a company's STORAGE invoice gets the same treatment", () => {
    // PRD §3.10: the client's terms "apply to removals and storage invoices
    // alike". Storage billed on the provider default while removals billed on
    // terms would have given one client two different answers.
    expect(STORAGE).toContain("...(storageDueDate ? { dueDate: storageDueDate } : {}),");
    expect(STORAGE).toContain('resolvePaymentPolicy(client) === "commercial"');
  });

  it("storage resolves terms through the SAME helpers as removals", () => {
    // Re-deriving "is this client commercial" or "what are their terms"
    // locally is how two surfaces come to disagree about one client. The
    // helpers also carry the legacy-null coercion that stops a missing value
    // reaching the date arithmetic as NaN.
    expect(STORAGE).toContain("paymentTermsDueDate(new Date(), paymentTermsDays(client?.payment_terms_days))");
    expect(STORAGE).toContain('from "@/lib/payments-policy"');
    // …and reads the columns it needs, or `client.payment_terms_days` is
    // undefined at runtime however correct the arithmetic looks.
    expect(STORAGE).toContain("is_company, payment_terms_days");
  });

  it("residential passes nothing on either rail", () => {
    // The control. Both call sites are conditional spreads keyed on a value
    // that is null for residential, so a residential invoice reaches the
    // provider exactly as it did before gate 10b.
    expect(FLOW).toContain("commercialDueDate ?? balanceDueDate(quote.moving_date)");
    expect(STORAGE).toMatch(/const storageDueDate =\s*\r?\n?\s*resolvePaymentPolicy\(client\) === "commercial"/);
  });
});
