/**
 * Job sheet — the crew's one-page A4 brief for a removal (iMVE job-sheet
 * clone-and-improve, docs/imve-discovery.md §4). Pure doc-def builder so tests
 * can walk it; rendered client-side by window.pdfMake (see <PdfLoader/>).
 *
 * Deliberately customer-price-FREE: crew sheets travel in van cabs and get
 * handed around — the job's money stays in the office. It carries what the
 * crew needs: addresses, access, inventory, crew/vehicles, notes, signature.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const C = {
  red: "#C03838",
  redSoft: "#FDF1F1",
  ink: "#1F1D1B",
  charcoal: "#2A2927",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  rowAlt: "#FCFAF7",
  white: "#FFFFFF",
};

export interface JobSheetAddress {
  address: string;
  postcode: string;
  propertyType: string; // house | flat | bungalow…
  floor: string;
  lift: string; // yes | no
  accessM: number;
}

export interface JobSheetData {
  quoteRef: string | null;
  customerName: string;
  customerPhone: string | null;
  moveDate: string | null; // yyyy-mm-dd
  timeWindow: string; // "All day" | "09:00–13:00"
  days: number;
  from: JobSheetAddress;
  to: JobSheetAddress;
  vehicleLabel: string; // "2 Luton Vans + 1 × 7.5t"
  packingLabel: string; // "Full Pack Service"
  crew: string[];
  vehicles: string[]; // "Luton 1 (AB12 CDE)"
  items: { label: string; qty: number }[];
  accessNotes: string;
  largeItemsNotes: string;
  jobNotes: string; // internal quote notes
}

const fmtDate = (d: string | null): string => {
  if (!d) return "Date TBC";
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? "Date TBC"
    : t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

const floorLabel = (a: JobSheetAddress): string => {
  const bits = [a.propertyType, a.floor === "ground" ? "ground floor" : `floor: ${a.floor}`];
  if (a.lift === "yes") bits.push("lift");
  if (a.accessM > 0) bits.push(`carry ~${a.accessM}m`);
  return bits.filter(Boolean).join(" · ");
};

function addressCard(title: string, a: JobSheetAddress): any {
  return {
    table: {
      widths: ["*"],
      body: [
        [{ text: title.toUpperCase(), style: "cardTitle", fillColor: C.charcoal }],
        [
          {
            stack: [
              { text: a.address || "—", style: "addr" },
              { text: a.postcode || "", style: "postcode", margin: [0, 2, 0, 4] },
              { text: floorLabel(a), style: "meta" },
            ],
            fillColor: C.softPanel,
            margin: [10, 8, 10, 8],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.75,
      vLineWidth: () => 0.75,
      hLineColor: () => C.border,
      vLineColor: () => C.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

function listCard(title: string, lines: string[], empty: string): any {
  return {
    table: {
      widths: ["*"],
      body: [
        [{ text: title.toUpperCase(), style: "cardTitle", fillColor: C.charcoal }],
        [
          {
            stack: lines.length
              ? lines.map((l) => ({ text: `•  ${l}`, style: "body", margin: [0, 1, 0, 1] }))
              : [{ text: empty, style: "meta" }],
            fillColor: C.white,
            margin: [10, 8, 10, 8],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.75,
      vLineWidth: () => 0.75,
      hLineColor: () => C.border,
      vLineColor: () => C.border,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

export function buildJobSheetDocDef(d: JobSheetData): any {
  const inventoryRows =
    d.items.length > 0
      ? d.items.map((i, idx) => [
          { text: i.label, style: "body", fillColor: idx % 2 ? C.rowAlt : C.white },
          { text: String(i.qty), style: "bodyQty", fillColor: idx % 2 ? C.rowAlt : C.white },
        ])
      : [[{ text: "No packing materials recorded on the quote.", style: "meta", colSpan: 2 }, {}]];

  const notes = [
    d.accessNotes ? `Access: ${d.accessNotes}` : null,
    d.largeItemsNotes ? `Large items: ${d.largeItemsNotes}` : null,
    d.jobNotes ? d.jobNotes : null,
  ].filter(Boolean) as string[];

  return {
    pageSize: "A4",
    pageMargins: [38, 38, 38, 46],
    // The site vfs ships ONLY Cormorant + Montserrat (no Roboto, pdfmake's
    // default) — an unset font makes createPdf hang forever. Always name one.
    defaultStyle: { font: "Montserrat", fontSize: 9.5, color: C.ink, lineHeight: 1.25 },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: "Marley Moves · 01747 637070 · hello@marleymoves.co.uk", style: "footerText" },
        { text: `Page ${page} of ${pages}`, style: "footerText", alignment: "right" },
      ],
      margin: [38, 12, 38, 0],
    }),
    styles: {
      brand: { font: "Cormorant", fontSize: 22, bold: true, color: C.ink },
      brandRed: { color: C.red },
      docTitle: { fontSize: 11, bold: true, color: C.muted, characterSpacing: 1 },
      hero: { fontSize: 13, bold: true, color: C.white },
      heroSub: { fontSize: 9.5, color: "#F4D9D9" },
      cardTitle: { fontSize: 8.5, bold: true, color: C.white, characterSpacing: 0.8, margin: [10, 5, 10, 5] },
      addr: { fontSize: 10.5, bold: true, color: C.ink },
      postcode: { fontSize: 12, bold: true, color: C.red },
      body: { fontSize: 9.5, color: C.ink },
      bodyQty: { fontSize: 9.5, bold: true, color: C.ink, alignment: "right" },
      meta: { fontSize: 8.5, color: C.muted },
      colHead: { fontSize: 8.5, bold: true, color: C.white },
      footerText: { fontSize: 7.5, color: C.muted },
    },
    content: [
      /* header */
      {
        columns: [
          { text: [{ text: "MARLEY ", style: "brand" }, { text: "MOVES", style: ["brand", "brandRed"] }] },
          { text: "JOB SHEET", style: "docTitle", alignment: "right", margin: [0, 7, 0, 0] },
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 519, y2: 0, lineWidth: 1, lineColor: C.border }], margin: [0, 8, 0, 12] },

      /* hero strip — who + when */
      {
        table: {
          widths: ["*", "auto"],
          body: [
            [
              {
                stack: [
                  { text: d.customerName || "Customer TBC", style: "hero" },
                  {
                    text: [d.customerPhone ?? "no phone on file", d.quoteRef ? `  ·  ${d.quoteRef}` : ""].join(""),
                    style: "heroSub",
                    margin: [0, 2, 0, 0],
                  },
                ],
                fillColor: C.charcoal,
                margin: [12, 10, 12, 10],
              },
              {
                stack: [
                  { text: fmtDate(d.moveDate), style: "hero", alignment: "right" },
                  {
                    text: `${d.timeWindow}${d.days > 1 ? `  ·  ${d.days}-day job` : ""}`,
                    style: "heroSub",
                    alignment: "right",
                    margin: [0, 2, 0, 0],
                  },
                ],
                fillColor: C.charcoal,
                margin: [12, 10, 12, 10],
              },
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 12],
      },

      /* from → to */
      {
        columns: [addressCard("Moving from", d.from), { width: 12, text: "" }, addressCard("Moving to", d.to)],
        margin: [0, 0, 0, 12],
      },

      /* resources */
      {
        columns: [
          {
            width: "*",
            stack: [
              listCard(
                "Crew",
                d.crew,
                "No crew assigned yet — check the Job Board.",
              ),
            ],
          },
          { width: 12, text: "" },
          {
            width: "*",
            stack: [
              listCard(
                "Vehicles",
                d.vehicles.length ? d.vehicles : d.vehicleLabel ? [`Required: ${d.vehicleLabel}`] : [],
                "No vehicles assigned yet — check the Job Board.",
              ),
            ],
          },
        ],
        margin: [0, 0, 0, 12],
      },

      /* job spec line */
      {
        table: {
          widths: ["*"],
          body: [
            [
              {
                text: [
                  { text: "JOB SPEC   ", style: "colHead", color: C.red },
                  { text: `${d.vehicleLabel}  ·  ${d.packingLabel}`, style: "body", bold: true },
                ],
                fillColor: C.redSoft,
                margin: [10, 7, 10, 7],
              },
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 12],
      },

      /* inventory */
      {
        table: {
          headerRows: 1,
          widths: ["*", 50],
          body: [
            [
              { text: "PACKING MATERIALS & INVENTORY", style: "colHead", fillColor: C.charcoal, margin: [10, 5, 10, 5] },
              { text: "QTY", style: "colHead", fillColor: C.charcoal, alignment: "right", margin: [10, 5, 10, 5] },
            ],
            ...inventoryRows.map((r: any[]) =>
              r.map((c: any) => ({ ...c, margin: [10, 4, 10, 4] })),
            ),
          ],
        },
        layout: {
          hLineWidth: () => 0.75,
          vLineWidth: () => 0.75,
          hLineColor: () => C.border,
          vLineColor: () => C.border,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 12],
      },

      /* notes */
      listCard("Notes for the crew", notes, "No notes recorded."),

      /* sign-off */
      {
        margin: [0, 16, 0, 0],
        table: {
          widths: ["*", 12, "*"],
          body: [
            [
              {
                stack: [
                  { text: "CUSTOMER SIGN-OFF", style: "colHead", color: C.red, margin: [0, 0, 0, 14] },
                  { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.75, lineColor: C.ink }] },
                  { text: "Signature — goods received in good order", style: "meta", margin: [0, 3, 0, 0] },
                ],
                border: [false, false, false, false],
              },
              { text: "", border: [false, false, false, false] },
              {
                stack: [
                  { text: "CREW LEAD", style: "colHead", color: C.red, margin: [0, 0, 0, 14] },
                  { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.75, lineColor: C.ink }] },
                  { text: "Name + signature on completion", style: "meta", margin: [0, 3, 0, 0] },
                ],
                border: [false, false, false, false],
              },
            ],
          ],
        },
        layout: "noBorders",
      },
    ],
  };
}
