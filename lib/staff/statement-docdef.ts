/**
 * Contractor invoice PDF (pure doc-def, browser-rendered via window.pdfMake —
 * same pipeline as the quote / job-sheet PDFs). ONE page A4.
 *
 * This is a self-employed contractor's INVOICE to Marley Moves — the contractor
 * generates + confirms it themselves (kept clear of HMRC "self-billing"). They
 * are NOT VAT-registered, so there is NO VAT line, NO VAT number, and the
 * document states "No VAT is chargeable". Kept pure so a test can walk the
 * doc-def without a browser.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const C = {
  red: "#C03838",
  ink: "#1F1D1B",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  tableHeader: "#262422",
  rowAlt: "#FCFAF7",
  white: "#FFFFFF",
  footer: "#5C5752",
};
const CONTENT_W = 519.28;

const fmtGBP = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDay(d: string | null): string {
  if (!d) return "";
  const t = new Date(`${d.slice(0, 10)}T12:00:00Z`);
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export interface StatementPdfLine {
  description: string;
  work_date: string | null;
  quantity: number | null;
  unit_amount: number | null;
  amount: number;
}

export interface StatementPdfData {
  ref: string;
  staffName: string;
  periodLabel: string;
  issuedDate: string;
  status: string;
  lines: StatementPdfLine[];
  total: number;
  note: string | null;
  logoDataUri?: string;
}

/** Build the pdfmake document definition. Pure. */
export function buildStatementDocDef(d: StatementPdfData): any {
  const logo = d.logoDataUri || "";
  const content: any[] = [];

  // ── Header ───────────────────────────────────────────────────────────
  content.push({
    columns: [
      {
        width: 250,
        stack: [
          logo ? { image: "marleyLogo", width: 108, margin: [0, 0, 0, 8] } : { text: "", margin: [0, 0, 0, 8] },
          { text: "Marley Moves Ltd", bold: true, fontSize: 9, color: C.ink },
          { text: "Company No. 15914266", fontSize: 8, color: C.muted, margin: [0, 1, 0, 0] },
        ],
      },
      {
        width: "*",
        stack: [
          { text: "Contractor Invoice", bold: true, fontSize: 22, color: C.ink, alignment: "right", margin: [0, 4, 0, 12] },
          {
            columns: [
              { width: "*", text: "" },
              {
                width: 210,
                stack: [
                  metaRow("Reference:", d.ref, C.red),
                  metaRow("Period:", d.periodLabel),
                  metaRow("Issued:", d.issuedDate),
                  metaRow("Status:", d.status.charAt(0).toUpperCase() + d.status.slice(1)),
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
    canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 1.4, lineColor: C.red }],
    margin: [0, 0, 0, 12],
  });

  // ── Parties ──────────────────────────────────────────────────────────
  content.push({
    columns: [
      { width: "*", stack: [label("FROM (CONTRACTOR)"), { text: d.staffName || "—", bold: true, fontSize: 11, color: C.ink }] },
      {
        width: "*",
        stack: [label("BILL TO"), { text: "Marley Moves Ltd", bold: true, fontSize: 11, color: C.ink, alignment: "right" }],
      },
    ],
    margin: [0, 0, 0, 14],
  });

  // ── Lines table ──────────────────────────────────────────────────────
  const hc = (t: string, alignment?: string) => ({
    text: t,
    bold: true,
    fontSize: 7.5,
    color: C.white,
    characterSpacing: 0.6,
    fillColor: C.tableHeader,
    margin: [0, 3, 0, 2],
    ...(alignment ? { alignment } : {}),
  });
  const zebra = d.lines.length >= 5;
  const body = [
    [hc("DESCRIPTION"), hc("DATE", "center"), hc("QTY", "center"), hc("RATE", "right"), hc("AMOUNT", "right")],
    ...d.lines.map((l, i) => {
      const fill = zebra && i % 2 === 1 ? C.rowAlt : C.white;
      return [
        { text: l.description, fontSize: 8.8, color: C.ink, fillColor: fill, margin: [0, 4, 0, 4] },
        { text: fmtDay(l.work_date), fontSize: 8.5, color: C.muted, alignment: "center", fillColor: fill, margin: [0, 4, 0, 4] },
        { text: l.quantity == null ? "—" : String(l.quantity), fontSize: 8.5, color: C.ink, alignment: "center", fillColor: fill, margin: [0, 4, 0, 4] },
        { text: l.unit_amount == null ? "—" : fmtGBP(l.unit_amount), fontSize: 8.5, color: C.ink, alignment: "right", fillColor: fill, margin: [0, 4, 0, 4] },
        { text: fmtGBP(l.amount), bold: true, fontSize: 8.7, color: C.ink, alignment: "right", fillColor: fill, margin: [0, 4, 0, 4] },
      ];
    }),
  ];
  content.push({
    table: { widths: ["*", 54, 40, 66, 70], headerRows: 1, keepWithHeaderRows: 1, body },
    layout: {
      hLineWidth: (i: number) => (i <= 1 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => C.border,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 5,
      paddingBottom: () => 5,
    },
    margin: [0, 0, 0, 12],
  });

  // ── Total (NO VAT) ───────────────────────────────────────────────────
  content.push({
    unbreakable: true,
    columns: [
      { width: "*", text: "" },
      {
        width: 260,
        table: {
          widths: ["*", "auto"],
          body: [
            [
              { text: "TOTAL DUE", bold: true, fontSize: 11, color: C.white, characterSpacing: 0.2, fillColor: C.red, margin: [17, 13, 0, 12], border: [false, false, false, false] },
              { text: fmtGBP(d.total), bold: true, fontSize: 19, color: C.white, alignment: "right", fillColor: C.red, margin: [0, 9, 17, 8], border: [false, false, false, false] },
            ],
          ],
        },
        layout: "noBorders",
      },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 12],
  });

  // ── No-VAT statement ─────────────────────────────────────────────────
  content.push({
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              {
                text: "Contractor invoice from a self-employed worker who is not VAT registered. No VAT is chargeable.",
                bold: true,
                fontSize: 8.4,
                color: C.ink,
              },
              ...(d.note
                ? [{ text: d.note, fontSize: 7.8, color: C.muted, margin: [0, 4, 0, 0] as number[] }]
                : []),
            ],
            margin: [12, 10, 12, 10],
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
  });

  return {
    info: { title: `Marley Moves Contractor Invoice ${d.ref}`, author: "Marley Moves Ltd", subject: "Contractor invoice", creator: "Marley Ops" },
    images: { marleyLogo: logo || "" },
    pageSize: "A4",
    pageMargins: [38, 32, 38, 52],
    defaultStyle: { font: "Montserrat", fontSize: 8.7, color: C.ink, lineHeight: 1.2 },
    footer: (currentPage: number, pageCount: number) => ({
      margin: [38, 6, 38, 0],
      stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 1, lineColor: C.red }] },
        {
          text: `Marley Moves Ltd  |  Company No. 15914266  |  Ref: ${d.ref}  |  Page ${currentPage} of ${pageCount}`,
          fontSize: 6.8,
          color: C.footer,
          alignment: "center",
          margin: [0, 7, 0, 0],
        },
      ],
    }),
    content,
  };

  function label(t: string) {
    return { text: t, bold: true, fontSize: 7.5, color: C.red, characterSpacing: 0.4, margin: [0, 0, 0, 3] as number[] };
  }
  function metaRow(l: string, v: string, valueColor = C.ink) {
    return {
      columns: [
        { width: 78, text: l, fontSize: 8.3, color: C.muted },
        { width: "*", text: v, bold: true, fontSize: 8.7, color: valueColor, alignment: "right", noWrap: false },
      ],
      margin: [0, 0, 0, 5] as number[],
    };
  }
}
