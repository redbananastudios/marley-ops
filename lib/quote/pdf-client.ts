/**
 * Client-side PDF module — faithful port of the live MM Quotes pdfmake doc-def
 * (quotes-app/public/index.html buildQuoteDocDef L2631-2872).
 *
 * This is a browser-only lib: it reaches for window.pdfMake (loaded by
 * <PdfLoader/> via next/script) and window for the cached logo data URI.
 * Every export guards for the browser + a loaded pdfMake before running.
 *
 * The doc-def layout, fonts, colours, line-item logic, totals panel + red
 * QUOTE TOTAL bar, route/ops cards, terms + bank details and the footer are
 * ported verbatim. The only change vs. the live tool is the data source:
 * the original read the DOM via gatherQuoteData(); here we take the typed
 * QuoteFormValues + a computed QuoteBreakdown as arguments.
 */

import { MILEAGE_RATE, type VehicleKey, type PackingKey, type FloorKey } from "./constants";
import { buildOpItems } from "./form-types";
import type { QuoteFormValues } from "./form-types";
import type { QuoteBreakdown } from "./pricing";

// pdfMake is loaded from the CDN onto window by <PdfLoader/>; no types ship here.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    pdfMake?: any;
    MARLEY_LOGO_DATA_URI?: string;
  }
}

// ── Colours (PDF_C, L2606-2610) ──────────────────────────────────────────
const PDF_C = {
  ink: "#1A1A1A",
  red: "#C03838",
  redBright: "#E85959",
  muted: "#6E6A65",
  paper: "#FAFAFA",
  border: "#EAE7E2",
  success: "#15803D",
  warnBg: "#FFFBEB",
  warnText: "#92400E",
};

const VEHICLE_LABELS: Record<VehicleKey, string> = {
  transit: "Transit Van",
  "1luton": "1 Luton Van",
  "2luton": "2 Luton Vans",
  "3luton": "3 Luton Vans",
  "4luton": "4 Luton Vans",
  "5luton": "5 Luton Vans",
};
const PACK_LABELS: Record<PackingKey, string> = {
  owner: "Owner Pack",
  fragile: "Fragile Only Pack",
  full: "Full Pack Service",
};

/** £ formatter — verbatim from the live tool (fmtGBP, L2665). */
const fmtGBP = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function requireBrowserPdfMake(): any {
  if (typeof window === "undefined") {
    throw new Error("Quote PDF can only be generated in the browser.");
  }
  const pdfMake = window.pdfMake;
  if (!pdfMake) {
    throw new Error("PDF library not loaded yet. Ensure <PdfLoader/> has mounted and the scripts have loaded.");
  }
  // Mirror setupPdfMakeFonts (L2611-2617): vfs_fonts.js wires pdfMake.fonts.Montserrat.
  if (!pdfMake.fonts || !pdfMake.fonts.Montserrat) {
    throw new Error("PDF fonts not loaded yet (vfs_fonts.js). Try again in a moment.");
  }
  return pdfMake;
}

/** Fetch /logo.png → data URI, cached on window (port of ensureLogoLoaded L2618-2629). */
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

interface PdfMeta {
  quoteRef: string;
  estimatorName?: string;
  logoDataUri?: string;
}

/**
 * Build the pdfmake document definition — faithful to the live layout.
 * Pure (no window reads); pass the logo via meta.logoDataUri.
 */
export function buildQuoteDocDef(values: QuoteFormValues, b: QuoteBreakdown, meta: PdfMeta): any {
  const quoteRef = meta.quoteRef;
  const estimator = meta.estimatorName || "—";
  const logoDataUri = meta.logoDataUri || "";

  const custName = (values.customer.name || "").trim();
  const custPhone = (values.customer.phone || "").trim();
  const custEmail = (values.customer.email || "").trim();
  const collectAddr = (values.job.collectAddr || "").trim();
  const destAddr = (values.job.destAddr || "").trim();

  const moveDateRaw = values.job.moveDate;
  const moveDateEstimated = !!values.job.moveDateEstimated;
  const moveDateLong = moveDateRaw
    ? new Date(moveDateRaw + "T00:00:00").toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }) + (moveDateEstimated ? " (estimated)" : "")
    : "TBC";
  const scope = values.job.scope || "rented";

  let vLabel = VEHICLE_LABELS[b.vehicle];
  if (b.sevenFiveT > 0) vLabel += b.sevenFiveT === 1 ? " + 7.5 Tonne" : ` + ${b.sevenFiveT} × 7.5 Tonne`;
  if ((b.transitVans ?? 0) > 0) vLabel += b.transitVans === 1 ? " + Transit Van" : ` + ${b.transitVans} × Transit Vans`;
  const packLabel = PACK_LABELS[b.packing];

  // Operational requirements (already filtered to qty>0, includes new items).
  const opItems = buildOpItems(values.items);

  const now = new Date();
  const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // ── shared cell builders (L2667-2674) ──────────────────────────────────
  const sectionLabel = (text: string, color: string = PDF_C.red) => ({
    text,
    font: "Montserrat",
    bold: true,
    fontSize: 11,
    color,
    margin: [0, 0, 0, 8],
  });
  const fieldLabel = (t: string) => ({
    text: t.toUpperCase(),
    font: "Montserrat",
    bold: true,
    fontSize: 7,
    color: PDF_C.red,
    characterSpacing: 1.1,
    margin: [0, 0, 0, 2],
  });
  const fieldValue = (t: string, opts: { bold?: boolean } = {}) => ({
    text: t || "—",
    font: "Montserrat",
    fontSize: opts.bold ? 11 : 9.5,
    bold: opts.bold || false,
    color: PDF_C.ink,
  });
  const card = (innerStack: any[]) => ({
    unbreakable: true,
    table: { widths: ["*"], body: [[{ stack: innerStack, border: [true, true, true, true], margin: [12, 12, 12, 12] }]] },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => PDF_C.border,
      vLineColor: () => PDF_C.border,
      fillColor: () => "#F8F8F7",
    },
  });

  const content: any[] = [];

  // ── HEADER ─────────────────────────────────────────────────────────────
  content.push({
    columns: [
      {
        width: "auto",
        table: { widths: [110], body: [[{ image: "marleyLogo", width: 100, alignment: "center", margin: [0, 6, 0, 6] }]] },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => PDF_C.border,
          vLineColor: () => PDF_C.border,
        },
      },
      {
        width: "*",
        alignment: "right",
        stack: [
          { text: "Moving Estimate", font: "Montserrat", bold: true, fontSize: 22, color: PDF_C.ink, margin: [0, 8, 0, 8] },
          {
            columns: [
              { width: "*", text: "" },
              {
                width: "auto",
                stack: [
                  {
                    columns: [
                      { width: 90, text: "Quote Reference:", font: "Montserrat", fontSize: 8.5, color: PDF_C.muted },
                      { text: quoteRef, font: "Montserrat", bold: true, fontSize: 8.5, color: PDF_C.ink, alignment: "right", noWrap: true },
                    ],
                    margin: [0, 0, 0, 3],
                  },
                  {
                    columns: [
                      { width: 90, text: "Date Issued:", font: "Montserrat", fontSize: 8.5, color: PDF_C.muted },
                      { text: fmtDate(now), font: "Montserrat", fontSize: 8.5, color: PDF_C.ink, alignment: "right" },
                    ],
                    margin: [0, 0, 0, 3],
                  },
                  {
                    columns: [
                      { width: 90, text: "Valid Until:", font: "Montserrat", fontSize: 8.5, color: PDF_C.muted },
                      { text: fmtDate(expiry), font: "Montserrat", bold: true, fontSize: 8.5, color: PDF_C.red, alignment: "right" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    columnGap: 14,
    margin: [0, 0, 0, 12],
  });

  // ── CARDS — CLIENT + JOB (single 2-col table so heights equalise) ───────
  const addrLines = (a: string): string[] => {
    if (!a) return ["—"];
    const parts = a.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : ["—"];
  };
  const spacer = { text: "", margin: [0, 0, 0, 6] };
  const clientStack = [
    sectionLabel("Client Information"),
    fieldLabel("Prepared For"),
    fieldValue(custName, { bold: true }),
    spacer,
    fieldLabel("Phone"),
    fieldValue(custPhone),
    spacer,
    fieldLabel("Email"),
    fieldValue(custEmail),
    spacer,
    fieldLabel("Prepared By"),
    fieldValue(estimator),
  ];
  const collectStack = addrLines(collectAddr).map((l, i) => fieldValue(l, i === 0 ? { bold: false } : {}));
  const destStack = addrLines(destAddr).map((l, i) => fieldValue(l, i === 0 ? { bold: false } : {}));
  const jobStack = [
    sectionLabel("Job Details"),
    fieldLabel("Collection"),
    ...collectStack,
    spacer,
    fieldLabel("Destination"),
    ...destStack,
    spacer,
    fieldLabel("Move Date"),
    fieldValue(moveDateLong),
    spacer,
    fieldLabel("Scope"),
    fieldValue(scope === "rented" ? "Rented" : "Owned"),
  ];
  content.push({
    table: {
      widths: ["*", "*"],
      body: [
        [
          { stack: clientStack, margin: [12, 12, 12, 12] },
          { stack: jobStack, margin: [12, 12, 12, 12] },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => PDF_C.border,
      vLineColor: () => PDF_C.border,
      fillColor: () => "#F8F8F7",
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 12],
  });

  // ── BREAKDOWN ───────────────────────────────────────────────────────────
  content.push({ text: "Quote Breakdown", font: "Montserrat", bold: true, fontSize: 13, color: PDF_C.ink, margin: [0, 0, 0, 8] });

  interface LineItem {
    label: string;
    detail: string;
    qty: number | string;
    unit: number;
    amount?: number;
  }
  const items: LineItem[] = [{ label: "Vehicle & Base", detail: vLabel, qty: 1, unit: b.base }];
  if (b.sevenFiveT > 0)
    items.push({
      label: b.sevenFiveT === 1 ? "+ 7.5 Tonne Vehicle" : `+ ${b.sevenFiveT} × 7.5 Tonne Vehicles`,
      detail: "",
      qty: 1,
      unit: b.addon75Cost,
    });
  if ((b.transitVans ?? 0) > 0)
    items.push({
      label: b.transitVans === 1 ? "+ Transit Van (1 man)" : `+ ${b.transitVans} × Transit Vans (1 man each)`,
      detail: "",
      qty: b.transitVans,
      unit: b.transitVans > 0 ? (b.transitCost ?? 0) / b.transitVans : 0,
      amount: b.transitCost ?? 0,
    });
  if (b.packCost + b.addon75PackCost > 0)
    items.push({ label: "Packing Service", detail: packLabel, qty: 1, unit: b.packCost + b.addon75PackCost });
  if (b.mileageCost !== null)
    items.push({
      label: "Mileage",
      detail: "Total mileage at £2.00/mi",
      qty: (b.totalMiles as number).toFixed(1) + " mi",
      unit: MILEAGE_RATE,
      amount: b.mileageCost,
    });
  if (b.collectAccessCost > 0) items.push({ label: "Collection Access", detail: "Distance from van to door", qty: 1, unit: b.collectAccessCost });
  if (b.destAccessCost > 0) items.push({ label: "Destination Access", detail: "Distance from van to door", qty: 1, unit: b.destAccessCost });
  if (b.collectFloorCost > 0)
    items.push({
      label: "Collection Floor Charge",
      detail: `Floor ${b.collectFloor.toUpperCase()} × ${b.vanCount} van${b.vanCount > 1 ? "s" : ""}`,
      qty: b.vanCount,
      unit: b.collectFloorCost / b.vanCount,
      amount: b.collectFloorCost,
    });
  if (b.destFloorCost > 0)
    items.push({
      label: "Destination Floor Charge",
      detail: `Floor ${b.destFloor.toUpperCase()} × ${b.vanCount} van${b.vanCount > 1 ? "s" : ""}`,
      qty: b.vanCount,
      unit: b.destFloorCost / b.vanCount,
      amount: b.destFloorCost,
    });
  if (b.congestion > 0) items.push({ label: "Congestion Charge", detail: "£20 per van", qty: b.vanCount, unit: 20, amount: b.congestion });
  if (b.tolls > 0) items.push({ label: "Toll Charges", detail: "", qty: 1, unit: b.tolls });
  if (b.parking > 0) items.push({ label: "Parking Permit", detail: "", qty: 1, unit: b.parking });
  // Administration fee is rolled silently into the quote total — no line item, no disclaimer.

  const headerCell = (text: string, alignment?: string) => ({
    text,
    font: "Montserrat",
    bold: true,
    fontSize: 8,
    color: PDF_C.muted,
    characterSpacing: 0.8,
    fillColor: "#F0EFEB",
    ...(alignment ? { alignment } : {}),
  });
  const tableBody = [
    [headerCell("NO.", "center"), headerCell("ITEM / SERVICES"), headerCell("QUANTITY", "right"), headerCell("UNIT PRICE", "right"), headerCell("AMOUNT", "right")],
    ...items.map((it, i) => {
      const amount = it.amount != null ? it.amount : it.unit * (it.qty as number);
      return [
        { text: String(i + 1), font: "Montserrat", fontSize: 9, color: PDF_C.muted, alignment: "center" },
        {
          stack: [
            { text: it.label, font: "Montserrat", bold: true, fontSize: 9.5, color: PDF_C.ink },
            ...(it.detail ? [{ text: "(" + it.detail + ")", font: "Montserrat", fontSize: 8, color: PDF_C.muted, margin: [0, 1, 0, 0] }] : []),
          ],
        },
        { text: String(it.qty), font: "Montserrat", fontSize: 9.5, color: PDF_C.ink, alignment: "right" },
        { text: fmtGBP(it.unit), font: "Montserrat", fontSize: 9.5, color: PDF_C.ink, alignment: "right" },
        { text: fmtGBP(amount), font: "Montserrat", bold: true, fontSize: 9.5, color: PDF_C.ink, alignment: "right" },
      ];
    }),
  ];
  content.push({
    table: { widths: [28, "*", 60, 70, 70], headerRows: 1, keepWithHeaderRows: 1, body: tableBody },
    layout: {
      hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.6 : 0.3),
      vLineWidth: () => 0,
      hLineColor: () => PDF_C.border,
      paddingTop: () => 7,
      paddingBottom: () => 7,
      paddingLeft: () => 8,
      paddingRight: () => 8,
    },
    margin: [0, 0, 0, 0],
  });

  // ── TOTALS PANEL ─────────────────────────────────────────────────────────
  const totalRows: any[] = [
    [
      { text: "Subtotal", font: "Montserrat", fontSize: 10, color: PDF_C.muted, alignment: "right", border: [false, false, false, false] },
      { text: fmtGBP(b.subtotal), font: "Montserrat", bold: true, fontSize: 10, color: PDF_C.ink, alignment: "right", border: [false, false, false, false] },
    ],
  ];
  if (b.discount > 0)
    totalRows.push([
      { text: "Discount", font: "Montserrat", fontSize: 10, color: PDF_C.success, alignment: "right", border: [false, false, false, false] },
      { text: "−" + fmtGBP(b.discount), font: "Montserrat", bold: true, fontSize: 10, color: PDF_C.success, alignment: "right", border: [false, false, false, false] },
    ]);
  totalRows.push([
    { text: b.vatEnabled ? "Tax (20%)" : "Tax (0%)", font: "Montserrat", fontSize: 10, color: PDF_C.muted, alignment: "right", border: [false, false, false, false] },
    { text: fmtGBP(b.vatAmount), font: "Montserrat", bold: true, fontSize: 10, color: PDF_C.ink, alignment: "right", border: [false, false, false, false] },
  ]);

  content.push({
    unbreakable: true,
    table: {
      widths: ["*", 260],
      body: [
        [
          { text: "", border: [false, false, false, false] },
          {
            stack: [
              {
                table: { widths: ["*", 110], body: totalRows },
                layout: { defaultBorder: false, paddingTop: () => 5, paddingBottom: () => 5, paddingLeft: () => 8, paddingRight: () => 12 },
                margin: [0, 0, 0, 6],
              },
              {
                table: {
                  widths: ["*", "auto"],
                  body: [
                    [
                      { text: "QUOTE TOTAL", font: "Montserrat", bold: true, fontSize: 13, color: "#FFFFFF", characterSpacing: 1.2, fillColor: PDF_C.red, margin: [16, 14, 0, 14], border: [false, false, false, false] },
                      { text: fmtGBP(b.grandTotal), font: "Montserrat", bold: true, fontSize: 18, color: "#FFFFFF", alignment: "right", fillColor: PDF_C.red, margin: [0, 12, 18, 12], border: [false, false, false, false] },
                    ],
                  ],
                },
                layout: "noBorders",
              },
            ],
            border: [false, false, false, false],
          },
        ],
      ],
    },
    layout: "noBorders",
    margin: [0, 4, 0, 12],
  });

  // ── ROUTE + OPS ──────────────────────────────────────────────────────────
  const hasRoute = b.totalMiles != null;
  const hasOps = opItems.length > 0;
  if (hasRoute || hasOps) {
    const deadMiles = values.route.deadMiles ?? 0;
    const jobMiles = values.route.jobMiles ?? 0;
    const routeCard = hasRoute
      ? card([
          sectionLabel("Route & Mileage", PDF_C.red),
          ...[
            ["Dead Miles (base -> collect + dest -> base)", deadMiles.toFixed(1) + " mi"],
            ["Job Miles (collect -> destination)", jobMiles.toFixed(1) + " mi"],
          ].map(([l, v]) => ({
            columns: [
              { text: l, font: "Montserrat", fontSize: 9, color: PDF_C.muted },
              { text: v, font: "Montserrat", bold: true, fontSize: 9, color: PDF_C.ink, alignment: "right", width: 60 },
            ],
            margin: [0, 0, 0, 6],
          })),
          { canvas: [{ type: "line", x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.5, lineColor: PDF_C.border }], margin: [0, 2, 0, 6] },
          {
            columns: [
              { text: "Total Miles", font: "Montserrat", bold: true, fontSize: 10, color: PDF_C.ink },
              { text: (b.totalMiles as number).toFixed(1) + " mi", font: "Montserrat", bold: true, fontSize: 11, color: PDF_C.red, alignment: "right", width: 60 },
            ],
          },
        ])
      : { text: "" };
    const opsCard = hasOps
      ? card([
          sectionLabel("Operational Requirements", PDF_C.red),
          ...opItems.map((i) => ({
            columns: [
              { text: i.label, font: "Montserrat", fontSize: 9, color: PDF_C.ink },
              { text: String(i.qty), font: "Montserrat", bold: true, fontSize: 9, color: PDF_C.ink, alignment: "right", width: 30 },
            ],
            margin: [0, 0, 0, 4],
          })),
        ])
      : { text: "" };
    if (hasRoute && hasOps) content.push({ columns: [routeCard, opsCard], columnGap: 12, margin: [0, 0, 0, 12] });
    else content.push({ ...(hasRoute ? routeCard : opsCard), margin: [0, 0, 0, 12] });
  }

  // ── TERMS ────────────────────────────────────────────────────────────────
  content.push({
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              sectionLabel("Terms & Notes"),
              {
                ul: [
                  { text: "This estimate is based on the information provided and is subject to change based on actual moving conditions.", font: "Montserrat", fontSize: 9, color: PDF_C.ink },
                  { text: "Any additional services or changes to the move will be discussed and agreed upon before execution.", font: "Montserrat", fontSize: 9, color: PDF_C.ink, margin: [0, 4, 0, 0] },
                ],
                margin: [0, 0, 0, 8],
              },
              {
                text: [
                  { text: "Payment terms: ", font: "Montserrat", bold: true, fontSize: 9, color: PDF_C.ink },
                  { text: "A £100 deposit confirms your removal. The balance is due on completion.", font: "Montserrat", fontSize: 9, color: PDF_C.ink },
                ],
                margin: [0, 0, 0, 8],
              },
              {
                columns: [
                  { width: "auto", text: "Bank details:", font: "Montserrat", bold: true, fontSize: 9, color: PDF_C.ink, margin: [0, 0, 10, 0] },
                  {
                    width: "*",
                    stack: [
                      { text: "MARLEYMOVES LTD", font: "Montserrat", bold: true, fontSize: 9, color: PDF_C.ink },
                      { text: "Sort code: 04-00-03", font: "Montserrat", fontSize: 9, color: PDF_C.ink, margin: [0, 1, 0, 0] },
                      { text: "Account: 12787423", font: "Montserrat", fontSize: 9, color: PDF_C.ink, margin: [0, 1, 0, 0] },
                    ],
                  },
                ],
              },
            ],
            border: [true, true, true, true],
            margin: [14, 18, 14, 14],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => PDF_C.border,
      vLineColor: () => PDF_C.border,
      fillColor: () => "#F8F8F7",
    },
    margin: [0, 18, 0, 12],
  });

  return {
    info: { title: `MarleyMoves Quote ${quoteRef}`, author: "MarleyMoves Ltd", subject: "Removal quote", creator: "MM Quotes" },
    images: { marleyLogo: logoDataUri || "" },
    pageSize: "A4",
    pageMargins: [38, 32, 38, 42],
    defaultStyle: { font: "Montserrat", fontSize: 9.5, color: PDF_C.ink, lineHeight: 1.25 },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [38, 10, 38, 0],
      columns: [
        {
          text: [
            { text: "Marley ", font: "Cormorant", bold: true, fontSize: 10, color: PDF_C.ink },
            { text: "Moves", font: "Cormorant", bold: true, fontSize: 10, color: PDF_C.red },
            { text: "  ·  Company No. 15914266  ·  01747 637070", font: "Montserrat", fontSize: 7.5, color: PDF_C.muted },
          ],
          noWrap: true,
        },
        {
          alignment: "right",
          text: [
            { text: `Ref ${quoteRef}`, font: "Montserrat", fontSize: 7.5, color: PDF_C.muted },
            { text: `   ·   Page ${currentPage} of ${pageCount}`, font: "Montserrat", fontSize: 7.5, color: PDF_C.muted },
          ],
        },
      ],
    }),
    content,
  };
}

/** Create the PDF and return base64 (no `data:` prefix). */
export async function quotePdfBase64(values: QuoteFormValues, b: QuoteBreakdown, meta: PdfMeta): Promise<string> {
  const pdfMake = requireBrowserPdfMake();
  const logoDataUri = meta.logoDataUri ?? (await ensureLogoDataUri());
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
  const logoDataUri = meta.logoDataUri ?? (await ensureLogoDataUri());
  const docDef = buildQuoteDocDef(values, b, { ...meta, logoDataUri });
  pdfMake.createPdf(docDef).download(`MarleyMoves-Quote-${meta.quoteRef}.pdf`);
}
