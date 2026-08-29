/**
 * Client-side quote PDF — built to the 2026-07-08 design spec
 * (marley-moves-quote-pdfmake-build-spec.md): a 2-page A4 document.
 *
 *   Page 1 — Removal Quote: header with contact rows, client/job cards with
 *   red icon badges, dark-header breakdown table, mileage callout, totals
 *   stack with the red TOTAL INCLUDING VAT bar, and an acceptance strip with
 *   reserved QR / accept-URL slots.
 *   Page 2 — Quote Assumptions & Terms: 10 icon rows, bank details card and
 *   the customer acceptance box (with its own QR slot).
 *
 * VAT-document rules (locked by tests/lib/quote/pdf-docdef.test.ts): every
 * charge in the subtotal is itemised — the line items sum EXACTLY to the
 * subtotal — and every amount renders N2 (0.00). The footer carries the VAT
 * number from Settings on every page.
 *
 * Browser-only render: reaches for window.pdfMake (loaded by <PdfLoader/>).
 * buildQuoteDocDef itself is pure so the tests can walk the real doc-def.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.6): a quote PDF carries its job's
 * brand. meta.brand ABSENT (or the default Marley brand, which callers never
 * pass) renders exactly today's Marley document; a non-default brand swaps the
 * accent colour, contact rows, legal line, title and wordmark from its brands
 * row — all data-driven, no slug switches, so brand 3 needs no code here.
 */

import type { QuoteFormValues } from "./form-types";
import type { QuoteBreakdown } from "./pricing";
import { customerLineItems } from "./line-items";
import { tintTowardsWhite, type DocBrand } from "@/lib/pdf/doc-brand";

// pdfMake is loaded from the CDN onto window by <PdfLoader/>; no types ship here.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    pdfMake?: any;
    MARLEY_LOGO_DATA_URI?: string;
  }
}

// ── Colour palette (spec §2) ─────────────────────────────────────────────
const C = {
  red: "#C03838",
  redSoft: "#FDF1F1",
  ink: "#1F1D1B",
  charcoal: "#2A2927",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  tableHeader: "#262422",
  rowAlt: "#FCFAF7",
  green: "#138A3D",
  footer: "#5C5752",
  acceptBorder: "#F1D8D8",
  acceptBoxBorder: "#F1C7C7",
  white: "#FFFFFF",
};

const CONTENT_W = 519.28; // A4 minus 38pt margins

/** £ formatter — ALWAYS two decimals (N2). Money on a VAT document never drops pence. */
const fmtGBP = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Whole-£ prose amounts ("£100 deposit") — pence only when they exist. */
const fmtGBPWhole = (n: number): string =>
  "£" + (Number.isInteger(n) ? String(n) : n.toFixed(2));

const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// ── Icon set (spec §5) — inner markup only; composed into badges below ──
const ICONS: Record<string, string> = {
  phone:
    '<path d="M6.5 4.5 9 7.2 7.4 9.1c1.1 2.2 2.8 3.9 5.5 5.5l1.9-1.6 2.7 2.5c.4.4.5 1 .2 1.5-.8 1.5-2 2.4-3.4 2.4C9.6 19.4 4.6 14.4 4.6 9.7c0-1.4.9-2.6 2.4-3.4.5-.3 1.1-.2 1.5.2Z"/>',
  email: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="m4.8 7.2 7.2 6 7.2-6"/>',
  web: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8"/><path d="M12 4C9.8 6.3 8.8 9 8.8 12s1 5.7 3.2 8"/>',
  person:
    '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19c.8-3.5 3-5.2 6.5-5.2s5.7 1.7 6.5 5.2"/>',
  job: '<rect x="5" y="8" width="14" height="10" rx="2"/><path d="M9 8V6.5c0-.9.6-1.5 1.5-1.5h3c.9 0 1.5.6 1.5 1.5V8"/><path d="M5 12h14"/><path d="M11 12v1h2v-1"/>',
  breakdown:
    '<rect x="5" y="4.5" width="14" height="15" rx="2"/><path d="M5 9h14"/><path d="M9.5 4.5v15"/><path d="M14.5 4.5v15"/><path d="M5 14h14"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  tick: '<path d="m6.5 12.5 3.5 3.5 7.5-8"/>',
  bank: '<path d="M4 10h16"/><path d="M5 10 12 5l7 5"/><path d="M6.5 10v7"/><path d="M10 10v7"/><path d="M14 10v7"/><path d="M17.5 10v7"/><path d="M4.5 18.5h15"/>',
  box: '<path d="m12 4 7 4-7 4-7-4 7-4Z"/><path d="M5 8v8l7 4 7-4V8"/><path d="M12 12v8"/>',
  document:
    '<path d="M7 4h7l4 4v12H7V4Z"/><path d="M14 4v4h4"/><path d="M9.5 12h5"/><path d="M9.5 15h5"/>',
  pound:
    '<path d="M15.5 8.2c-.6-1.3-1.7-2-3.1-2-2 0-3.4 1.4-3.4 3.6v7"/><path d="M7 12h7"/><path d="M7 18h10"/>',
  calendar:
    '<rect x="5" y="6.5" width="14" height="12" rx="2"/><path d="M8.5 4.5v4"/><path d="M15.5 4.5v4"/><path d="M5 10h14"/><path d="M8.5 13.5h.01"/><path d="M12 13.5h.01"/><path d="M15.5 13.5h.01"/>',
  parking: '<path d="M9 18V6h4.5c2.2 0 3.5 1.4 3.5 3.4s-1.3 3.4-3.5 3.4H9"/>',
  package:
    '<path d="M4.5 8 12 4l7.5 4-7.5 4-7.5-4Z"/><path d="M4.5 8v8l7.5 4 7.5-4V8"/><path d="M8.5 6 16 10"/>',
  prohibited: '<circle cx="12" cy="12" r="8"/><path d="m7 17 10-10"/>',
  shield:
    '<path d="M12 4.5 18 7v4.5c0 4-2.4 6.7-6 8-3.6-1.3-6-4-6-8V7l6-2.5Z"/><path d="m9.5 12 1.7 1.7 3.5-4"/>',
  claims:
    '<path d="M7 4h7l4 4v12H7V4Z"/><path d="M14 4v4h4"/><path d="M9.5 12h5"/><path d="M9.5 15h3"/><circle cx="16.5" cy="16.5" r="1.5"/>',
  cloud:
    '<path d="M8 17h8.5a3 3 0 0 0 .4-6 5 5 0 0 0-9.5-1.7A3.8 3.8 0 0 0 8 17Z"/><path d="M10 20h.01"/><path d="M14 20h.01"/>',
};

/** Solid accent circle badge with a white line icon (cards, callout, strip).
 *  `colour` defaults to Marley red so the no-brand path stays byte-identical. */
function solidBadge(icon: string, size = 28, iconSize = 15, strokeW = 1.8, colour = C.red): string {
  const off = (size - iconSize) / 2;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${colour}"/>` +
    `<g transform="translate(${off},${off}) scale(${iconSize / 24})" fill="none" stroke="${C.white}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>` +
    `</svg>`
  );
}

/** Outlined badge — white fill, accent ring + accent line icon (terms rows). */
function outlineBadge(icon: string, size = 28, iconSize = 14, colour = C.red): string {
  const off = (size - iconSize) / 2;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 0.6}" fill="${C.white}" stroke="${colour}" stroke-width="1.2"/>` +
    `<g transform="translate(${off},${off}) scale(${iconSize / 24})" fill="none" stroke="${colour}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>` +
    `</svg>`
  );
}

/** Small bare line icon (header contact rows). */
function inlineIcon(icon: string, size = 10, color = C.ink): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`
  );
}

function requireBrowserPdfMake(): any {
  if (typeof window === "undefined") {
    throw new Error("Quote PDF can only be generated in the browser.");
  }
  const pdfMake = window.pdfMake;
  if (!pdfMake) {
    throw new Error("PDF library not loaded yet. Ensure <PdfLoader/> has mounted and the scripts have loaded.");
  }
  if (!pdfMake.fonts || !pdfMake.fonts.Montserrat) {
    throw new Error("PDF fonts not loaded yet (vfs_fonts.js). Try again in a moment.");
  }
  return pdfMake;
}

/** Fetch /logo.png → data URI, cached on window. */
export async function ensureLogoDataUri(): Promise<string> {
  if (typeof window === "undefined") return "";
  if (window.MARLEY_LOGO_DATA_URI != null) return window.MARLEY_LOGO_DATA_URI;
  try {
    const res = await fetch("/logo.png", { cache: "force-cache" });
    const blob = await res.blob();
    window.MARLEY_LOGO_DATA_URI = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    window.MARLEY_LOGO_DATA_URI = "";
  }
  return window.MARLEY_LOGO_DATA_URI || "";
}

/** PDF filename — brand short name prefixes (PRD §10: Pitmans-Quote-PMR001.pdf);
 *  no/default brand keeps today's exact Marley shape. The brand object is the
 *  shared DocBrand (lib/pdf/doc-brand.ts) so every gate-14 doc-def speaks one
 *  slim serialisable shape, resolved at the caller via docBrandFrom (null for
 *  the default brand — these literals ARE its rendering). */
export function quotePdfFilename(quoteRef: string, brand?: DocBrand | null): string {
  return `${brand ? brand.shortName : "MarleyMoves"}-Quote-${quoteRef}.pdf`;
}

/** "https://www.example.co.uk/" → "www.example.co.uk" for the header row. */
const displayUrl = (u: string): string => u.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** Bare address out of "Name <address>" (hello_from tolerates both shapes). */
const emailAddress = (s: string): string => {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim();
};

interface PdfMeta {
  quoteRef: string;
  estimatorName?: string;
  logoDataUri?: string;
  /** VAT registration number (Settings) — footer shows "VAT No. —" when absent. */
  vatNumber?: string;
  /** Deposit £ (Settings defaultDeposit) — used in the acceptance strip + terms. */
  depositAmount?: number;
  /** Public accept-page URL — renders the QR slots + "Accept online" line when set. */
  acceptUrl?: string;
  /**
   * Which ladder this quote runs (PRD §3.10). Absent means residential, so
   * every existing call site keeps today's document byte-for-byte.
   *
   * A commercial quote takes NO deposit and cannot be accepted online — the
   * server refuses the click (gate 10b) — so this document must not ask for one
   * or point a QR code at a page that will turn the customer away. It is the
   * same defect QA-20260828-03 recorded against `/q`, except a PDF is ATTACHED
   * TO THE QUOTE EMAIL: it reaches the customer whether or not they ever open
   * the link, and it is the artefact they keep.
   */
  paymentPolicy?: "residential" | "commercial";
  /** Non-default brand for this quote (PRD §3.6). Absent/null → today's Marley
   *  document, byte-identical. Resolved at the call site from quotes.brand via
   *  docBrandFrom (which returns null for the default brand). */
  brand?: DocBrand | null;
}

// Static bank details (as the live tool prints them).
const BANK = { name: "MARLEYMOVES LTD", sortCode: "04-00-03", account: "12787423" };

const TERMS: { icon: string; title: string; body: (deposit: string) => string }[] = [
  {
    icon: "box",
    title: "What this quote includes",
    body: () =>
      "Professional removal of your household goods as detailed in this quote, carried out by our experienced team using appropriately sized vehicles and equipment.",
  },
  {
    icon: "document",
    title: "Quote basis",
    body: () =>
      "This quote is based on the information provided and is subject to change based on actual conditions at the time of the move.",
  },
  {
    icon: "pound",
    title: "Deposit & payment",
    body: (d) =>
      `A booking deposit of ${d} is required to secure your booking. The balance is due on completion of the removal unless agreed otherwise in writing.`,
  },
  {
    icon: "calendar",
    title: "Cancellation & postponement",
    body: () =>
      "Cancellations made with less than 48 hours' notice may incur charges. Postponements are subject to availability and may incur additional costs.",
  },
  {
    icon: "parking",
    title: "Access, parking & waiting time",
    body: () =>
      "Please ensure clear access and parking for our vehicle. Charges may apply for long carries, restricted access, or waiting time caused by access issues.",
  },
  {
    icon: "package",
    title: "Customer packing responsibilities",
    body: () =>
      "Customers are responsible for packing and preparing their items unless a packing service has been arranged and confirmed in advance.",
  },
  {
    icon: "prohibited",
    title: "Restricted items",
    body: () =>
      "We do not move hazardous materials, perishable goods, plants, pets, or items prohibited by law. Please inform us in advance of any items requiring special handling.",
  },
  {
    icon: "shield",
    title: "Liability & damage",
    body: () =>
      "We take all reasonable care with your belongings. Our liability is limited to loss or damage caused by our negligence and does not include pre-existing damage, poor customer packing, defective furniture, or items not suitable for normal removal handling.",
  },
  {
    icon: "claims",
    title: "Claims",
    body: () =>
      "Any claims for loss or damage must be notified in writing within 7 days of completion of the move. We will investigate promptly and fairly.",
  },
  {
    icon: "cloud",
    title: "Delays outside our control",
    body: () =>
      "We are not liable for delays caused by traffic, weather, roadworks, vehicle breakdown, key delays, property chain delays, or any other circumstances beyond our reasonable control.",
  },
];

/**
 * The one clause that differs by policy — swapped in place rather than dropped.
 *
 * Dropping it would leave a commercial quote's terms silent on payment
 * altogether, which is worse than the wrong clause: the customer would have no
 * written statement of when the invoice comes or what terms it runs on. Swapped
 * in place, the clause keeps its position in the list and its icon, so only the
 * words a commercial customer would have found untrue actually change.
 */
const COMMERCIAL_PAYMENT_TERM = {
  icon: "pound",
  title: "Payment",
  // Deliberately says "nothing is payable up front" rather than "no deposit is
  // required": it states the same fact without printing the word, which lets
  // the test scan the WHOLE document for that word and fail on any future copy
  // that reintroduces an ask. A clause that has to name the thing it denies
  // would have forced a narrower assertion, and narrow is how the ask crept
  // into three separate places here to begin with.
  body: () =>
    "Nothing is payable up front. We invoice your account once the removal is complete, payable on the terms agreed with your account.",
};

/** The terms list this quote prints. Residential is the array above, untouched. */
function termsFor(commercial: boolean): typeof TERMS {
  if (!commercial) return TERMS;
  return TERMS.map((t) => (t.icon === "pound" ? COMMERCIAL_PAYMENT_TERM : t));
}

/** Build the pdfmake document definition. Pure — the tests walk this directly. */
export function buildQuoteDocDef(values: QuoteFormValues, b: QuoteBreakdown, meta: PdfMeta): any {
  const quoteRef = meta.quoteRef;
  const estimator = meta.estimatorName || "—";
  // ── Brand (PRD §3.6) — absent means Marley, and the Marley path keeps every
  // literal below untouched. A non-default brand swaps the accent palette
  // (DocBrand.colour is already WCAG-picked: the accent only when white text is
  // legible on it, else the primary — Pitmans yellow fails, blue wins), the
  // contact/legal text and the wordmark; a row with no usable colour arrives as
  // the Marley red and therefore keeps the literal red palette below.
  const brand = meta.brand || null;
  const accent = brand?.colour ?? C.red;
  const accentSoft = accent === C.red ? C.redSoft : tintTowardsWhite(accent, 0.92);
  const accentStripBorder = accent === C.red ? C.acceptBorder : tintTowardsWhite(accent, 0.78);
  const accentBoxBorder = accent === C.red ? C.acceptBoxBorder : tintTowardsWhite(accent, 0.7);
  // The only embeddable logo is Marley's same-origin /logo.png; a non-default
  // brand's logo_url is remote (and a Phase-0 stub anyway), so those documents
  // render a text wordmark in the brand colour instead — never Marley's logo.
  const logoDataUri = brand ? "" : meta.logoDataUri || "";
  const commercial = meta.paymentPolicy === "commercial";
  const deposit = fmtGBPWhole(meta.depositAmount != null && meta.depositAmount > 0 ? meta.depositAmount : 100);
  // Commercial is never accepted online, so the accept URL is dropped HERE, at
  // the single point every downstream reader takes it from — the strip's link,
  // its QR, and the acceptance box's QR all key off this one binding. Blanking
  // it at each render site instead would leave three places to forget, and the
  // one forgotten would put a live QR on the page that refuses it.
  //
  // The `£100` fallback on the line above is deliberately left alone: a
  // commercial quote's deposit_amount is 0, which would fall through to £100,
  // and `deposit` is now read only by copy this flag turns off.
  const acceptUrl = commercial ? "" : (meta.acceptUrl || "").trim();

  const custName = (values.customer.name || "").trim();
  const custPhone = (values.customer.phone || "").trim();
  const custEmail = (values.customer.email || "").trim();
  const collectAddr = (values.job.collectAddr || "").trim();
  const destAddr = (values.job.destAddr || "").trim();

  const moveDateRaw = values.job.moveDate;
  const moveDateLong = moveDateRaw
    ? new Date(moveDateRaw + "T00:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }) + (values.job.moveDateEstimated ? " (estimated)" : "")
    : "TBC";
  const scope = values.job.scope === "owned" ? "Owned" : "Rented";

  const now = new Date();
  const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const addrLines = (a: string): string[] => {
    if (!a) return ["—"];
    const parts = a.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : ["—"];
  };

  // ── small text helpers (spec §3) ─────────────────────────────────────
  const cardLabel = (t: string) => ({
    text: t,
    bold: true,
    fontSize: 7.5,
    color: accent,
    margin: [0, 0, 0, 2] as number[],
  });
  const cardValue = (t: string, opts: { bold?: boolean } = {}) => ({
    text: t || "—",
    fontSize: 9.5,
    bold: opts.bold || false,
    color: C.ink,
  });
  const spacer = (h = 8) => ({ text: "", margin: [0, 0, 0, h] as number[] });

  /** White card with 0.8pt border; inner stack padded. */
  const card = (inner: any[], fill = C.white) => ({
    unbreakable: true,
    table: { widths: ["*"], body: [[{ stack: inner, margin: [12, 10, 12, 10] }]] },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: () => 0.8,
      hLineColor: () => C.border,
      vLineColor: () => C.border,
      fillColor: () => fill,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  });

  const cardHeading = (icon: string, title: string) => ({
    columns: [
      { width: 28, svg: solidBadge(icon, 28, 15, 1.8, accent), margin: [0, 0, 0, 0] },
      { width: "*", text: title, bold: true, fontSize: 10, color: C.ink, characterSpacing: 0.2, margin: [9, 8, 0, 0] },
    ],
    margin: [0, 0, 0, 10],
  });

  const content: any[] = [];

  // ═══ PAGE 1 — HEADER ═════════════════════════════════════════════════
  const contactRow = (icon: string, text: string) => ({
    columns: [
      { width: 12, svg: inlineIcon(icon), margin: [0, 1, 0, 0] },
      { width: "*", text, fontSize: 8.2, color: C.ink, margin: [6, 0, 0, 0] },
    ],
    margin: [2, 0, 0, 5],
  });

  const metaRow = (label: string, value: string, valueColor = C.ink, valueBold = true) => ({
    columns: [
      { width: 88, text: label, fontSize: 8.3, color: C.muted },
      { width: "*", text: value, bold: valueBold, fontSize: 8.7, color: valueColor, alignment: "right", noWrap: true },
    ],
    margin: [0, 0, 0, 5],
  });

  // Brand identity block — logo (Marley) or text wordmark (non-default brands),
  // plus the group-line disclosure, which the PRD requires wherever the brand
  // identity appears (§1). The Marley branch renders exactly today's header.
  const identityStack = (wordmarkSize: number, logoWidth: number): any[] =>
    brand
      ? [
          { text: brand.name, bold: true, fontSize: wordmarkSize, color: accent, margin: [0, 2, 0, 2] },
          ...(brand.groupLine
            ? [{ text: brand.groupLine, fontSize: 7.5, color: C.muted, margin: [0, 0, 0, 8] }]
            : [{ text: "", margin: [0, 0, 0, 8] }]),
        ]
      : [logoDataUri ? { image: "marleyLogo", width: logoWidth, margin: [0, 0, 0, 8] } : { text: "", margin: [0, 0, 0, 8] }];

  const brandContactRows = brand
    ? [
        ...(brand.phone ? [contactRow("phone", brand.phone)] : []),
        ...(brand.email ? [contactRow("email", emailAddress(brand.email))] : []),
        ...(brand.websiteUrl ? [contactRow("web", displayUrl(brand.websiteUrl))] : []),
      ]
    : [
        contactRow("phone", "01747 637070"),
        contactRow("email", "hello@marleymoves.co.uk"),
        contactRow("web", "www.marleymoves.co.uk"),
      ];

  content.push({
    columns: [
      {
        width: 250,
        stack: [...identityStack(15, 108), ...brandContactRows],
      },
      {
        width: "*",
        stack: [
          { text: "Removal Quote", bold: true, fontSize: 24, color: C.ink, alignment: "right", margin: [0, 4, 0, 14] },
          {
            columns: [
              { width: "*", text: "" },
              {
                width: 200,
                stack: [
                  metaRow("Quote Reference:", quoteRef, accent),
                  metaRow("Date Issued:", fmtDate(now)),
                  metaRow("Valid Until:", fmtDate(expiry), accent),
                ],
              },
            ],
          },
        ],
      },
    ],
    columnGap: 14,
    margin: [0, 0, 0, 8],
  });
  content.push({
    canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 1.4, lineColor: accent }],
    margin: [0, 0, 0, 12],
  });

  // ═══ CLIENT + JOB CARDS ══════════════════════════════════════════════
  const clientStack = [
    cardHeading("person", "CLIENT INFORMATION"),
    cardLabel("Prepared for"),
    cardValue(custName, { bold: true }),
    spacer(),
    cardLabel("Phone"),
    cardValue(custPhone),
    spacer(),
    cardLabel("Email"),
    cardValue(custEmail),
  ];
  const miniDivider = {
    canvas: [{ type: "line", x1: 0, y1: 0, x2: 86, y2: 0, lineWidth: 0.6, lineColor: C.border }],
    margin: [0, 4, 0, 6] as number[],
  };
  const jobStack = [
    cardHeading("job", "JOB DETAILS"),
    {
      columns: [
        {
          width: "*",
          stack: [
            cardLabel("Collection"),
            ...addrLines(collectAddr).map((l) => cardValue(l)),
            spacer(),
            cardLabel("Destination"),
            ...addrLines(destAddr).map((l) => cardValue(l)),
          ],
        },
        {
          width: 96,
          stack: [
            cardLabel("Move Date"),
            cardValue(moveDateLong),
            miniDivider,
            cardLabel("Prepared by"),
            cardValue(estimator),
            miniDivider,
            cardLabel("Scope"),
            cardValue(scope),
          ],
        },
      ],
      columnGap: 10,
    },
  ];
  content.push({
    columns: [
      { width: 242, ...card(clientStack) },
      { width: "*", ...card(jobStack) },
    ],
    columnGap: 13,
    margin: [0, 0, 0, 12],
  });

  // ═══ QUOTE BREAKDOWN ═════════════════════════════════════════════════
  content.push({
    columns: [
      { width: 28, svg: solidBadge("breakdown", 28, 15, 1.8, accent) },
      { width: "*", text: "QUOTE BREAKDOWN", bold: true, fontSize: 10.5, color: C.ink, characterSpacing: 0.3, margin: [9, 8, 0, 0] },
    ],
    margin: [0, 0, 0, 9],
  });

  // CUSTOMER-facing line items (lib/quote/line-items.ts): the fleet base lines +
  // the admin fee collapse into one "Your Removal" line and no label names a van
  // count or crew size. The items still sum EXACTLY to the subtotal — a VAT
  // document must reconcile — the admin fee lives inside "Your Removal".
  const items = customerLineItems(b);

  const headerCell = (text: string, alignment?: string) => ({
    text,
    bold: true,
    fontSize: 7.5,
    color: C.white,
    characterSpacing: 0.6,
    fillColor: C.tableHeader,
    margin: [0, 2, 0, 1],
    ...(alignment ? { alignment } : {}),
  });
  const zebra = items.length >= 5;
  const tableBody = [
    [headerCell("NO.", "center"), headerCell("ITEM / SERVICES"), headerCell("QUANTITY", "center"), headerCell("UNIT PRICE", "right"), headerCell("AMOUNT", "right")],
    ...items.map((it, i) => {
      const amount = it.amount;
      const fill = zebra && i % 2 === 1 ? C.rowAlt : C.white;
      return [
        { text: String(i + 1), fontSize: 8.7, color: C.muted, alignment: "center", fillColor: fill, margin: [0, 4, 0, 0] },
        {
          stack: [
            { text: it.label, bold: true, fontSize: 8.8, color: C.ink },
            ...(it.detail ? [{ text: "(" + it.detail + ")", fontSize: 7.5, color: C.muted, margin: [0, 1.5, 0, 0] }] : []),
          ],
          fillColor: fill,
        },
        { text: String(it.qty), fontSize: 8.7, color: C.ink, alignment: "center", fillColor: fill, margin: [0, 4, 0, 0] },
        { text: fmtGBP(it.unit), fontSize: 8.7, color: C.ink, alignment: "right", fillColor: fill, margin: [0, 4, 0, 0] },
        { text: fmtGBP(amount), bold: true, fontSize: 8.7, color: C.ink, alignment: "right", fillColor: fill, margin: [0, 4, 0, 0] },
      ];
    }),
  ];
  content.push({
    table: { widths: [34, "*", 72, 78, 74], headerRows: 1, keepWithHeaderRows: 1, body: tableBody },
    layout: {
      hLineWidth: (i: number) => (i <= 1 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => C.border,
      paddingTop: () => 7,
      paddingBottom: () => 6,
      paddingLeft: () => 8,
      paddingRight: () => 8,
    },
    margin: [0, 0, 0, 0],
  });

  // ═══ MILEAGE CALLOUT + TOTALS STACK ══════════════════════════════════
  const totalsRows: any[] = [
    [
      { text: "Subtotal", fontSize: 8.8, color: C.ink, alignment: "right", border: [false, false, false, false] },
      { text: fmtGBP(b.subtotal), bold: true, fontSize: 8.8, color: C.ink, alignment: "right", border: [false, false, false, false] },
    ],
  ];
  if (b.discount > 0)
    totalsRows.push([
      { text: "Discount", fontSize: 8.8, color: C.green, alignment: "right", border: [false, false, false, false] },
      { text: "−" + fmtGBP(b.discount), bold: true, fontSize: 8.8, color: C.green, alignment: "right", border: [false, false, false, false] },
    ]);
  totalsRows.push([
    { text: b.vatEnabled ? "VAT (20%)" : "VAT (0%)", fontSize: 8.8, color: C.ink, alignment: "right", border: [false, false, false, false] },
    { text: fmtGBP(b.vatAmount), bold: true, fontSize: 8.8, color: C.ink, alignment: "right", border: [false, false, false, false] },
  ]);

  content.push({
    unbreakable: true,
    columns: [
      {
        width: 230,
        table: {
          widths: ["*"],
          body: [
            [
              {
                columns: [
                  { width: 20, svg: solidBadge("info", 20, 11, 1.8, accent) },
                  {
                    width: "*",
                    text: "Mileage is calculated from base to collection, collection to destination, and return to base.",
                    fontSize: 7.3,
                    lineHeight: 1.25,
                    color: C.ink,
                    margin: [8, 0, 0, 0],
                  },
                ],
                margin: [12, 11, 12, 11],
              },
            ],
          ],
        },
        layout: {
          hLineWidth: () => 0.6,
          vLineWidth: () => 0.6,
          hLineColor: () => C.border,
          vLineColor: () => C.border,
          fillColor: () => C.softPanel,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
      { width: "*", text: "" },
      {
        width: 253,
        stack: [
          {
            table: { widths: ["*", 90], body: totalsRows },
            layout: { defaultBorder: false, paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 8, paddingRight: () => 8 },
            margin: [0, 0, 0, 7],
          },
          {
            table: {
              widths: ["*", "auto"],
              body: [
                [
                  { text: "TOTAL INCLUDING VAT", bold: true, fontSize: 10, color: C.white, characterSpacing: 0.2, fillColor: accent, margin: [17, 14, 0, 13], border: [false, false, false, false] },
                  { text: fmtGBP(b.grandTotal), bold: true, fontSize: 19, color: C.white, alignment: "right", fillColor: accent, margin: [0, 9, 17, 8], border: [false, false, false, false] },
                ],
              ],
            },
            layout: "noBorders",
          },
        ],
      },
    ],
    columnGap: 10,
    margin: [0, 12, 0, 12],
  });

  // ═══ ACCEPTANCE STRIP (QR + accept-URL slots) ════════════════════════
  const stripText = commercial
    ? "Nothing to pay now. We will confirm this booking with you and invoice your account once the move is complete, payable on your agreed terms."
    : acceptUrl
      ? `To accept this quote and pay your ${deposit} deposit, scan the QR code or use the link below.`
      : `To accept this quote, reply in writing and pay the ${deposit} deposit.`;
  const stripLeft: any = {
    width: "*",
    stack: [
      { text: stripText, bold: true, fontSize: 9.2, color: C.ink, margin: [0, acceptUrl ? 2 : 8, 0, 0] },
      ...(acceptUrl
        ? [{ text: `Accept online: ${acceptUrl}`, fontSize: 6.5, color: C.muted, margin: [0, 5, 0, 0], link: acceptUrl }]
        : []),
    ],
    margin: [12, 0, 0, 0],
  };
  content.push({
    unbreakable: true,
    table: {
      widths: ["*"],
      body: [
        [
          {
            columns: [
              { width: 28, svg: solidBadge("tick", 28, 15, 2.1, accent), margin: [0, acceptUrl ? 6 : 2, 0, 0] },
              stripLeft,
              ...(acceptUrl ? [{ width: 60, qr: acceptUrl, fit: 58, foreground: C.ink, margin: [0, 0, 0, 0] }] : []),
            ],
            margin: [15, 13, 15, 13],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.7,
      vLineWidth: () => 0.7,
      hLineColor: () => accentStripBorder,
      vLineColor: () => accentStripBorder,
      fillColor: () => accentSoft,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  });

  // ═══ PAGE 2 — QUOTE ASSUMPTIONS & TERMS ══════════════════════════════
  content.push({
    pageBreak: "before",
    columns: [
      {
        width: 130,
        stack: brand
          ? [
              { text: brand.name, bold: true, fontSize: 11, color: accent, margin: [0, 20, 0, 1] },
              ...(brand.groupLine ? [{ text: brand.groupLine, fontSize: 6.5, color: C.muted }] : []),
            ]
          : [logoDataUri ? { image: "marleyLogo", width: 92 } : { text: "" }],
      },
      { width: "*", text: "Quote Assumptions & Terms", bold: true, fontSize: 19, color: C.ink, alignment: "right", margin: [0, 26, 0, 0] },
    ],
    columnGap: 14,
    margin: [0, 0, 0, 8],
  });
  content.push({
    canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 1.4, lineColor: accent }],
    margin: [0, 0, 0, 4],
  });

  content.push({
    table: {
      widths: [40, "*"],
      body: termsFor(commercial).map((t) => [
        { svg: outlineBadge(t.icon, 26, 13, accent), border: [false, false, false, false], margin: [2, 6, 0, 6] },
        {
          stack: [
            { text: t.title, bold: true, fontSize: 9.3, color: C.ink, margin: [0, 0, 0, 2] },
            { text: t.body(deposit), fontSize: 7.4, lineHeight: 1.22, color: C.ink },
          ],
          border: [false, false, false, false],
          margin: [8, 6, 0, 6],
        },
      ]),
    },
    layout: {
      hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => C.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 4, 0, 10],
  });

  // ═══ BANK DETAILS + CUSTOMER ACCEPTANCE ══════════════════════════════
  const bankRow = (label: string, value: string) => ({
    columns: [
      { width: 58, text: label, fontSize: 8.2, color: C.ink },
      { width: "*", text: value, bold: true, fontSize: 8.2, color: C.ink },
    ],
    margin: [0, 0, 0, 4],
  });
  const bankStack = [
    {
      columns: [
        { width: 26, svg: solidBadge("bank", 26, 14, 1.8, accent) },
        { width: "*", text: "BANK DETAILS", bold: true, fontSize: 8, color: accent, characterSpacing: 0.3, margin: [8, 8, 0, 0] },
      ],
      margin: [0, 0, 0, 8],
    },
    { text: BANK.name, bold: true, fontSize: 8.6, color: C.ink, margin: [0, 0, 0, 6] },
    bankRow("Sort code:", BANK.sortCode),
    bankRow("Account:", BANK.account),
    bankRow("Reference:", quoteRef),
  ];

  const sigLine = (label: string) => ({
    columns: [
      { width: 46, text: label, fontSize: 7, color: C.ink, margin: [0, 4, 0, 0] },
      {
        width: "*",
        canvas: [{ type: "line", x1: 0, y1: 10, x2: 176, y2: 10, lineWidth: 0.6, lineColor: C.muted }],
      },
    ],
    margin: [0, 0, 0, 5],
  });
  const acceptanceInner: any[] = [
    { text: "CUSTOMER ACCEPTANCE", bold: true, fontSize: 8, color: accent, characterSpacing: 0.3, margin: [0, 0, 0, 5] },
    {
      // The signature block STAYS for commercial. PRD §3.10 takes no signature
      // in the system — the office confirms — and records the missing
      // customer-side artefact as an accepted risk; a signed returned PDF is
      // the one artefact that answers it, so removing the block would make that
      // risk worse rather than better. Only the obligation it recites changes:
      // a commercial customer pays no deposit, so naming one asked them to
      // agree to something we will never invoice.
      text: commercial
        ? "By confirming in writing, I accept this quote and agree to the terms and conditions outlined above."
        : acceptUrl
          ? "By paying the deposit or accepting online, I accept this quote and agree to the terms and conditions outlined above."
          : "By paying the deposit or confirming in writing, I accept this quote and agree to the terms and conditions outlined above.",
      fontSize: 6.9,
      lineHeight: 1.28,
      color: C.ink,
      margin: [0, 0, 0, 7],
    },
    sigLine("Name:"),
    sigLine("Signature:"),
    sigLine("Date:"),
  ];
  const acceptanceBox = acceptUrl
    ? {
        columns: [
          { width: "*", stack: acceptanceInner },
          {
            width: 66,
            stack: [
              { qr: acceptUrl, fit: 60, foreground: C.ink },
              { text: "Accept online", fontSize: 6, color: C.muted, alignment: "center", margin: [0, 3, 0, 0] },
            ],
            margin: [6, 4, 0, 0],
          },
        ],
      }
    : { stack: acceptanceInner };

  content.push({
    unbreakable: true,
    columns: [
      { width: 190, ...card(bankStack, C.softPanel) },
      {
        width: "*",
        table: { widths: ["*"], body: [[{ stack: [acceptanceBox], margin: [12, 10, 12, 10] }]] },
        layout: {
          hLineWidth: () => 0.8,
          vLineWidth: () => 0.8,
          hLineColor: () => accentBoxBorder,
          vLineColor: () => accentBoxBorder,
          fillColor: () => C.white,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        unbreakable: true,
      },
    ],
    columnGap: 13,
  });

  // Footer legal text. Marley keeps today's exact string; a non-default brand
  // renders its brands-row legal line (the trading-name wording), which may
  // already carry the VAT number — only add the "VAT No." segment when it
  // doesn't (a VAT document's footer must state it exactly once, on every page).
  const digits = (s: string) => s.replace(/\D/g, "");
  const legalCarriesVat =
    !!brand && !!meta.vatNumber && !!digits(meta.vatNumber) && brand.legalLine.replace(/\D/g, "").includes(digits(meta.vatNumber));
  const footerParts = brand
    ? [
        brand.legalLine,
        ...(legalCarriesVat ? [] : [`VAT No. ${meta.vatNumber || "—"}`]),
        ...(brand.phone ? [brand.phone] : []),
        `Ref: ${quoteRef}`,
      ]
    : null;

  return {
    info: brand
      ? { title: `${brand.name} Quote ${quoteRef}`, author: brand.name, subject: "Removal quote", creator: "Marley Ops" }
      : { title: `MarleyMoves Quote ${quoteRef}`, author: "Marley Moves Ltd", subject: "Removal quote", creator: "Marley Ops" },
    images: { marleyLogo: logoDataUri || "" },
    pageSize: "A4",
    pageMargins: [38, 32, 38, 52],
    defaultStyle: { font: "Montserrat", fontSize: 8.7, color: C.ink, lineHeight: 1.2 },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [38, 6, 38, 0],
      stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 1, lineColor: accent }] },
        {
          text: footerParts
            ? [...footerParts, `Page ${currentPage} of ${pageCount}`].join("  |  ")
            : [
                "Marley Moves Ltd  |  Company No. 15914266  |  ",
                `VAT No. ${meta.vatNumber || "—"}`,
                "  |  01747 637070  |  ",
                `Ref: ${quoteRef}`,
                `  |  Page ${currentPage} of ${pageCount}`,
              ].join(""),
          fontSize: 6.8,
          color: C.footer,
          alignment: "center",
          margin: [0, 7, 0, 0],
        },
      ],
    }),
    content,
  };
}

/** Create the PDF and return base64 (no `data:` prefix). */
export async function quotePdfBase64(values: QuoteFormValues, b: QuoteBreakdown, meta: PdfMeta): Promise<string> {
  const pdfMake = requireBrowserPdfMake();
  // A non-default brand never embeds Marley's /logo.png — don't fetch it.
  const logoDataUri = meta.brand ? "" : meta.logoDataUri ?? (await ensureLogoDataUri());
  const docDef = buildQuoteDocDef(values, b, { ...meta, logoDataUri });
  return new Promise<string>((resolve, reject) => {
    try {
      pdfMake.createPdf(docDef).getBase64((data: string) => resolve(data));
    } catch (err) {
      reject(err);
    }
  });
}

/** Create the PDF and trigger a browser download. */
export async function downloadQuotePdf(values: QuoteFormValues, b: QuoteBreakdown, meta: PdfMeta): Promise<void> {
  const pdfMake = requireBrowserPdfMake();
  const logoDataUri = meta.brand ? "" : meta.logoDataUri ?? (await ensureLogoDataUri());
  const docDef = buildQuoteDocDef(values, b, { ...meta, logoDataUri });
  pdfMake.createPdf(docDef).download(quotePdfFilename(meta.quoteRef, meta.brand));
}
