import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classifyBooking, owedNow, type BookingBucket, type QueueSignals } from "@/lib/bookings/queue";
import { moneySectionsOf, type MoneySectionRow } from "@/lib/bookings/sections";

/**
 * Two source-level guards over the /bookings and /payments Due money surfaces:
 *
 *   1. every BookingBucket's rows are RENDERED by some section of /bookings;
 *   2. both pages take their money headlines off the one per-obligation seam
 *      (`queueMoney`), never off a bucket filter.
 *
 * The type system can enforce neither. Both pages dispatch by FILTERING
 * (`rows.filter(r => r.bucket === b)`), one call per bucket, rather than by an
 * exhaustive switch — so adding a bucket to the union compiles cleanly, and
 * any booking that classifies into it renders on no screen at all. Silent, and
 * invisible in exactly the way that matters: the row is a real job with real
 * money against it.
 *
 * This bit for real once already, one layer down: `/bookings` hid the
 * commitment queues behind a booked diary slot, so a date-confirmed job that
 * was never put in the diary had its 25% invoice on no screen (the reason
 * `payments-card.tsx` grew a commitment cell, and half of QA-20260826-01).
 *
 * The guards read the TypeScript AST rather than the raw file text, because
 * the three things a text scan gets wrong here are all "I could not check"
 * rendering as clean:
 *
 *   - slicing the union at the first `;` after the declaration truncates it at
 *     the first JSDoc comment containing one (there are already three comment
 *     blocks inside `BookingBucket`), and the members past it are never
 *     checked at all — the test still passes, on a partial set;
 *   - `page.includes('by("x")')` proves a CALL exists, not that anything
 *     renders its rows, so a dead binding satisfies it — precisely the failure
 *     this file exists to catch;
 *   - a substring check on one exact expression is passed by the same wrong
 *     sum written any other way.
 *
 * What these guards still cannot prove: that the rendered figure is arithmetic-
 * ally right. That is `tests/lib/bookings/queue.test.ts` (the seam's maths) and
 * `e2e/office/bookings.spec.ts` (the tiles are really on screen).
 */

function parse(rel: string): ts.SourceFile {
  const path = join(process.cwd(), rel);
  // setParentNodes = true: the bucket walk climbs `.parent` to find which
  // binding, if any, a `by("...")` call is assigned to.
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const BOOKINGS = "app/(dashboard)/bookings/page.tsx";
const PAYMENTS_DUE = "app/(dashboard)/payments/due-tab.tsx";

/** The union members, read from the source so the list can never drift. */
function declaredBuckets(): string[] {
  const src = parse("lib/bookings/queue.ts");
  const alias = src.statements.find(
    (n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === "BookingBucket",
  );
  expect(alias, "type BookingBucket not found in lib/bookings/queue.ts — did it move?").toBeDefined();
  const members = ts.isUnionTypeNode(alias!.type) ? alias!.type.types : [alias!.type];
  // Fail loud on a member this guard cannot read (an imported alias, a
  // template literal type). Skipping it silently would drop a bucket from
  // coverage while the run still reported clean.
  return members.map((m) => {
    expect(
      ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal),
      `BookingBucket member "${m.getText()}" is not a string literal — this guard cannot check it`,
    ).toBe(true);
    return ((m as ts.LiteralTypeNode).literal as ts.StringLiteral).text;
  });
}

/** Every `const`/`let` in a file, by name, to its initialiser expression. */
function initialisers(src: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) out.set(n.name.text, n.initializer);
    n.forEachChild(walk);
  };
  walk(src);
  return out;
}

/**
 * Bindings whose rows actually reach the DOM: anything `x.map(...)`-ed inside
 * JSX, plus anything a rendered binding is built FROM. The second half is not
 * slack — `commercialInvoiced` is the binding that renders, and it is built by
 * concatenating `commercialOverdue`, so the overdue rows do have a home. A
 * binding nothing references (the dead-binding case) can never be reached this
 * way, which is the whole point.
 */
function renderedBindings(src: ts.SourceFile): Set<string> {
  const initialiserOf = initialisers(src);
  const rendered = new Set<string>();
  const walkJsx = (n: ts.Node, inJsx: boolean) => {
    const jsx = inJsx || ts.isJsxExpression(n);
    if (
      jsx &&
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "map" &&
      ts.isIdentifier(n.expression.expression)
    ) {
      rendered.add(n.expression.expression.text);
    }
    n.forEachChild((c) => walkJsx(c, jsx));
  };
  walkJsx(src, false);

  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...rendered]) {
      const init = initialiserOf.get(name);
      if (!init) continue;
      const walkIds = (n: ts.Node) => {
        if (ts.isIdentifier(n) && initialiserOf.has(n.text) && !rendered.has(n.text)) {
          rendered.add(n.text);
          grew = true;
        }
        n.forEachChild(walkIds);
      };
      walkIds(init);
    }
  }
  return rendered;
}

/**
 * Per bucket: which bindings carry its `by("...")` call, and whether the call
 * is mapped straight into the JSX with no binding at all.
 */
function bucketCarriers(src: ts.SourceFile): Map<string, { bindings: Set<string>; inlineJsx: boolean }> {
  const out = new Map<string, { bindings: Set<string>; inlineJsx: boolean }>();
  const walk = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "by" &&
      n.arguments.length === 1 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      const bucket = (n.arguments[0] as ts.StringLiteralLike).text;
      const entry = out.get(bucket) ?? { bindings: new Set<string>(), inlineJsx: false };
      out.set(bucket, entry);
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
          entry.bindings.add(p.name.text);
          break;
        }
        if (ts.isJsxExpression(p)) {
          entry.inlineJsx = true;
          break;
        }
      }
    }
    n.forEachChild(walk);
  };
  walk(src);
  return out;
}

/** `label` -> the source text of that `<Stat value={...}>`. */
function statTiles(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: ts.Node) => {
    const attrs =
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText() === "Stat"
        ? n.attributes
        : null;
    if (attrs) {
      let label: string | null = null;
      let value: string | null = null;
      for (const a of attrs.properties) {
        if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name) || !a.initializer) continue;
        if (a.name.text === "label" && ts.isStringLiteral(a.initializer)) label = a.initializer.text;
        if (a.name.text === "value" && ts.isJsxExpression(a.initializer) && a.initializer.expression) {
          value = a.initializer.expression.getText();
        }
      }
      if (label && value) out.set(label, value);
    }
    n.forEachChild(walk);
  };
  walk(src);
  return out;
}

/** The name a `queueMoney(...)` result is bound to on this page. */
function seamBinding(src: ts.SourceFile): string | undefined {
  for (const [name, init] of initialisers(src)) {
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "queueMoney") {
      return name;
    }
  }
  return undefined;
}

/** For `fmt(seam.field)`, the field name; null for anything else. */
function seamField(expr: string | undefined, seam: string): string | null {
  const m = /^[A-Za-z_$][\w$]*\((\w+)\.(\w+)\)$/.exec(expr ?? "");
  return m && m[1] === seam ? m[2] : null;
}

const TODAY = "2026-08-20";

const base: QueueSignals = {
  depositPaidAt: "2026-08-01T10:00:00Z",
  hasRemovalAppt: false,
  apptDayUk: null,
  provisionalDate: null,
  approxWindow: null,
  approxMonth: null,
  commitmentPaidAt: null,
  commitmentInvoiceAmount: null,
  commitmentDueDate: null,
  dateReleasableAt: null,
  balancePaidAt: null,
  balanceInvoiceNumber: null,
};

const commercial: Partial<QueueSignals> = {
  depositPaidAt: null,
  paymentPolicy: "commercial",
  jobCompleted: true,
  hasRemovalAppt: true,
  apptDayUk: "2026-08-01",
};

/** One set of signals per bucket. A new bucket with no entry here fails the
 *  first test below, which is the point: it cannot be added without someone
 *  saying what a row in it looks like and where it renders. */
const SIGNALS: Record<string, Partial<QueueSignals>> = {
  deposit_outstanding: { depositPaidAt: null },
  no_date: {},
  provisional: { provisionalDate: "2026-09-10" },
  commitment_overdue: {
    hasRemovalAppt: true,
    apptDayUk: "2026-09-10",
    commitmentInvoiceAmount: 450,
    commitmentDueDate: "2026-08-10",
  },
  commitment_due: {
    hasRemovalAppt: true,
    apptDayUk: "2026-09-10",
    commitmentInvoiceAmount: 450,
    commitmentDueDate: "2026-08-30",
  },
  balance_overdue: { hasRemovalAppt: true, apptDayUk: "2026-08-15" },
  balance_due: { hasRemovalAppt: true, apptDayUk: "2026-08-24" },
  commercial_awaiting_completion: { ...commercial },
  commercial_invoiced: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: "2026-09-30" },
  commercial_overdue: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: "2026-08-10" },
  // Invoiced, no terms date. The other two commercial rows differ from this
  // one ONLY in carrying a date, which is the distinction the bucket exists
  // to make: without it this row classified `commercial_invoiced` and
  // rendered as reassuringly in-terms on the strength of knowing nothing.
  commercial_terms_unknown: { ...commercial, balanceInvoiceNumber: "MM-BAL", commercialDueDate: null },
  all_set: { hasRemovalAppt: true, apptDayUk: "2026-10-30" },
};

/** A representative row for one bucket, built by running the REAL classifier
 *  over the signals — which is what stops a fixture drifting away from the
 *  rule it claims to describe. */
function rowFor(bucket: string): MoneySectionRow {
  const sig: QueueSignals = { ...base, ...SIGNALS[bucket] };
  const classified = classifyBooking(sig, TODAY);
  expect(classified, `the fixture for "${bucket}" no longer classifies into it`).toBe(bucket as BookingBucket);
  return {
    bucket: classified,
    paymentPolicy: sig.paymentPolicy === "commercial" ? "commercial" : "residential",
    deposit: 100,
    owed: owedNow(
      {
        commitmentInvoiceAmount: Number(sig.commitmentInvoiceAmount ?? 0),
        commitmentPaidAt: sig.commitmentPaidAt,
        commitmentDueDate: sig.commitmentDueDate,
        dateReleasableAt: sig.dateReleasableAt,
        balanceAmount: 1500,
        balancePaidAt: sig.balancePaidAt,
        balanceInvoiceNumber: sig.balanceInvoiceNumber,
        hasRemovalAppt: sig.hasRemovalAppt,
        apptDayUk: sig.apptDayUk,
        paymentPolicy: sig.paymentPolicy,
        commercialDueDate: sig.commercialDueDate,
      },
      TODAY,
    ),
  };
}

describe("BookingBucket coverage", () => {
  it("every declared bucket has a representative row", () => {
    const missing = declaredBuckets().filter((b) => !SIGNALS[b]);
    expect(
      missing,
      `no fixture describes a booking in: ${missing.join(", ")}. Add one, and say which section renders it.`,
    ).toEqual([]);
  });

  it("every bucket is rendered by /bookings — by name, or by the money it owes", () => {
    // The page dispatches TWO ways, so this checks both. Lifecycle rungs are
    // still filtered by name — `by("no_date")` — and the AST walk below is
    // what proves such a call actually reaches the DOM rather than merely
    // existing. Money rungs are filtered by OBLIGATION off
    // lib/bookings/sections.ts, where the bucket name need never appear at
    // all; for those, a representative row landing in a money section IS the
    // home, and sections.test.ts proves every money section renders a total.
    //
    // Checking only one mechanism would be an "I could not check" reading as
    // clean either way round: the source walk alone now reports every money
    // bucket as homeless while it renders perfectly, and the obligation check
    // alone would miss the lifecycle rungs, which owe nothing by definition.
    const page = parse(BOOKINGS);
    const carriers = bucketCarriers(page);
    const rendered = renderedBindings(page);
    const homeless = declaredBuckets().filter((b) => {
      if (moneySectionsOf(rowFor(b)).length > 0) return false;
      const carrier = carriers.get(b);
      if (!carrier) return true; // never filtered for at all
      if (carrier.inlineJsx) return false; // mapped straight into the JSX
      return ![...carrier.bindings].some((name) => rendered.has(name));
    });
    expect(
      homeless,
      `these buckets classify rows that /bookings renders nowhere: ${homeless.join(", ")}. ` +
        `A by("...") call is not a home — a binding nothing maps over renders no rows, and a count ` +
        `pill is not rows either. A booking in an unrendered bucket is a real job with real money ` +
        `that appears on no screen: give it a lifecycle section (filtered by name) or a money ` +
        `section (lib/bookings/sections.ts), or do not classify into it.`,
    ).toEqual([]);
  });

  it("/payments Due renders the same money seam, so no obligation is dropped from its total", () => {
    // /payments deliberately lists FEWER lifecycle sections than /bookings (it
    // is the money read, not the action queue). What it may never do is print
    // section totals that do not reach the headline above them, which is what
    // bucket-filtered lists did: the per-obligation headline counted a gate 9b
    // late booking's balance and no section on the page held it.
    const due = parse(PAYMENTS_DUE).getFullText();
    expect(due).toContain("queueMoney(rows)");
    expect(due).toContain("groupMoneySections(rows)");
    // Every list on the page takes its rows from that grouping. A reintroduced
    // `rows.filter(r => r.bucket === ...)` here is the QA-20260826-01 shape
    // returning on the surface that reported it.
    expect(due).not.toMatch(/rows\.filter\(\(r\) => r\.bucket ===/);
  });
  it("the /bookings tiles and the /payments headline read one queueMoney seam", () => {
    // This is the source half of the identity queue.test.ts names: /bookings
    // shows the 25% and the balance as two tiles, /payments Due shows their
    // sum as "Owed right now". Asserting `commitment + balance === owedNow`
    // against queueMoney alone proves nothing — that IS owedNow's definition,
    // so it holds for every input. What has to be pinned is that the three
    // figures on the two PAGES are those three fields of one call over one row
    // set. Together with the seam's arithmetic in queue.test.ts, that is the
    // whole identity; neither half proves it alone.
    const bookings = parse(BOOKINGS);
    const payments = parse(PAYMENTS_DUE);

    // Same rows. A page that grew its own read could diverge from the other
    // while every assertion below still passed.
    for (const [name, src] of [
      ["/bookings", bookings],
      ["/payments Due", payments],
    ] as const) {
      expect(src.getFullText(), `${name} no longer loads the shared booking ledger`).toContain("loadBookingRows(sb)");
    }

    // Same seam: one queueMoney call per page.
    const bookingsSeam = seamBinding(bookings);
    const paymentsSeam = seamBinding(payments);
    expect(bookingsSeam, "/bookings no longer computes its money with queueMoney").toBeDefined();
    expect(paymentsSeam, "/payments Due no longer computes its money with queueMoney").toBeDefined();

    // Each headline reads a named field off that seam. Pinned POSITIVELY
    // rather than by forbidding one spelling of the wrong sum: a tile rewritten
    // to sum a bucket has to stop reading the seam's field, however it is
    // written, and that is what fails here. QA-20260826-01 is exactly that
    // regression — the 25% tile summed the commitment_* buckets, which the
    // ladder only reaches once the deposit is paid AND the slot is in the
    // diary, so an invoiced-and-unpaid 25% read as £0 on /bookings while
    // /payments counted it.
    const tiles = statTiles(bookings);
    const tile = (label: string) => seamField(tiles.get(label), bookingsSeam!);
    expect(tile("25% outstanding"), `/bookings "25% outstanding" is not ${bookingsSeam}.commitment`).toBe(
      "commitment",
    );
    expect(tile("Balances outstanding"), `/bookings "Balances outstanding" is not ${bookingsSeam}.balance`).toBe(
      "balance",
    );
    // Deposits is the one tile that still shares a section's title, so it is
    // pinned to that section's OWN total rather than to the seam: two
    // expressions that merely agree today are what let a tile and a section
    // print different money under one heading. sections.test.ts guards the
    // rule; this pins the tile the rule is about.
    expect(
      tiles.get("Deposits outstanding"),
      `/bookings "Deposits outstanding" no longer reads its own section's total`,
    ).toContain('sectionSum("deposits_outstanding")');
    expect(
      seamField(statTiles(payments).get("Owed right now"), paymentsSeam!),
      `/payments Due "Owed right now" is not ${paymentsSeam}.owedNow`,
    ).toBe("owedNow");
  });
});
