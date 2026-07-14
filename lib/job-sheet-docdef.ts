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

import type { SurveyInventoryRoom } from "@/lib/cubic-survey";

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

export interface JobSheetPhoto {
  dataUri: string;
  label: string; // category ("Access" / "Large items / extra packing")
  caption: string;
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
  /** Cubic-survey summary — "Volume: 812 ft³ (≈2 Lutons) · 3 to dismantle". Price-free. */
  volumeLine?: string | null;
  /** Survey photos (data URIs) — rendered on their own page when present. */
  photos?: JobSheetPhoto[];
  /** Full room-grouped survey item list — price-free, notMoving lines flagged. */
  surveyInventory?: SurveyInventoryRoom[];
  /** How many AI walkthrough videos exist for this job (a PDF can't play them,
   *  so the sheet shows a QR to the job page instead). */
  videoCount?: number;
  /** Absolute URL to this job's /my-jobs/[id] page — encoded into the video QR. */
  jobUrl?: string | null;
  /** Contract signature state: false = accepted quote with NO signature yet
   *  (crew must collect on arrival); null/undefined = no accepted quote. */
  contractSigned?: boolean | null;
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
  const cellM = [10, 4, 10, 4];
  // NOTE: the colSpan filler MUST stay a bare {} — giving it any property
  // (even just a margin) sends pdfmake's layout into an infinite loop.
  const inventoryRows =
    d.items.length > 0
      ? d.items.map((i, idx) => [
          { text: i.label, style: "body", fillColor: idx % 2 ? C.rowAlt : C.white, margin: cellM },
          { text: String(i.qty), style: "bodyQty", fillColor: idx % 2 ? C.rowAlt : C.white, margin: cellM },
        ])
      : [[{ text: "No packing materials recorded on the quote.", style: "meta", colSpan: 2, margin: cellM }, {}]];

  const notes = [
    d.volumeLine ? d.volumeLine : null,
    d.accessNotes ? `Access: ${d.accessNotes}` : null,
    d.largeItemsNotes ? `Large items: ${d.largeItemsNotes}` : null,
    d.jobNotes ? d.jobNotes : null,
  ].filter(Boolean) as string[];

  /* survey photos — their own page, two per row */
  const photos = d.photos ?? [];
  const photoCell = (p: JobSheetPhoto): any => ({
    stack: [
      { image: p.dataUri, fit: [246, 185] },
      { text: p.caption ? `${p.label} — ${p.caption}` : p.label, style: "meta", margin: [0, 3, 0, 0] },
    ],
    width: "*",
  });
  const photoRows: any[] = [];
  for (let i = 0; i < photos.length; i += 2) {
    photoRows.push({
      columns: [photoCell(photos[i]), { width: 12, text: "" }, photos[i + 1] ? photoCell(photos[i + 1]) : { width: "*", text: "" }],
      margin: [0, 0, 0, 12],
    });
  }
  const photoSection: any[] = photos.length
    ? [
        { text: "SURVEY PHOTOS", style: "colHead", color: C.red, pageBreak: "before" as const, margin: [0, 0, 0, 10] },
        ...photoRows,
      ]
    : [];

  /* survey inventory — the FULL room-grouped item list the survey collected,
     price-free. notMoving lines stay in, clearly marked. */
  const surveyRooms = d.surveyInventory ?? [];
  const flagLabel = (f: { dismantle: boolean; fragile: boolean; notMoving: boolean }): string => {
    const bits: string[] = [];
    if (f.notMoving) bits.push("NOT MOVING — leave in place");
    if (f.dismantle) bits.push("Dismantle");
    if (f.fragile) bits.push("Fragile");
    return bits.join(" · ");
  };
  const surveyBody: any[] = [
    [
      { text: "ITEM", style: "colHead", fillColor: C.charcoal, margin: [10, 5, 10, 5] },
      { text: "QTY", style: "colHead", fillColor: C.charcoal, alignment: "right", margin: [10, 5, 10, 5] },
      { text: "FT³", style: "colHead", fillColor: C.charcoal, alignment: "right", margin: [10, 5, 10, 5] },
      { text: "NOTES", style: "colHead", fillColor: C.charcoal, margin: [10, 5, 10, 5] },
    ],
  ];
  for (const grp of surveyRooms) {
    surveyBody.push([
      { text: grp.room, style: "colHead", color: C.red, fillColor: C.softPanel, colSpan: 4, margin: [10, 5, 10, 5] },
      {},
      {},
      {},
    ]);
    grp.items.forEach((it, idx) => {
      const fill = idx % 2 ? C.rowAlt : C.white;
      const flags = flagLabel(it.flags);
      const noteBits = [flags || null, it.note || null].filter(Boolean).join(" — ");
      surveyBody.push([
        { text: it.title, style: "body", fillColor: fill, margin: cellM },
        { text: String(it.qty), style: "bodyQty", fillColor: fill, margin: cellM },
        { text: it.ft3 ? String(it.ft3) : "", style: "bodyQty", fillColor: fill, margin: cellM },
        {
          text: noteBits,
          style: it.flags.notMoving ? "flagWarn" : "meta",
          fillColor: fill,
          margin: cellM,
        },
      ]);
    });
  }
  const surveyInventorySection: any[] = surveyRooms.length
    ? [
        {
          table: { headerRows: 1, widths: ["*", 34, 40, "*"], body: surveyBody },
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
      ]
    : [];

  /* survey walkthrough videos — a PDF can't play them; a single QR scan opens
     the (assignment-gated) job page on the crew member's phone. */
  const videoCount = d.videoCount ?? 0;
  const videoSection: any[] =
    videoCount > 0 && d.jobUrl
      ? [
          {
            table: {
              widths: ["*", "auto"],
              body: [
                [
                  {
                    stack: [
                      { text: "SURVEY WALKTHROUGH VIDEOS", style: "colHead", color: C.red },
                      {
                        text: `${videoCount} video${videoCount === 1 ? "" : "s"} on file. Scan to open this job in Marley Ops on your phone and watch the walkthrough.`,
                        style: "body",
                        margin: [0, 4, 0, 0],
                      },
                    ],
                    fillColor: C.redSoft,
                    margin: [10, 9, 10, 9],
                  },
                  {
                    stack: [{ qr: d.jobUrl, fit: 90, foreground: C.ink }],
                    fillColor: C.redSoft,
                    alignment: "center",
                    margin: [10, 8, 12, 8],
                  },
                ],
              ],
            },
            layout: "noBorders",
            margin: [0, 0, 0, 12],
          },
        ]
      : [];

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
      flagWarn: { fontSize: 8.5, bold: true, color: C.red },
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

      /* contract flag — never gates the move, but the crew must see it */
      ...(d.contractSigned === false
        ? [
            {
              table: {
                widths: ["*"],
                body: [
                  [
                    {
                      text: "CONTRACT NOT YET SIGNED — collect the customer's signature on arrival (My jobs → this job → Collect signature now).",
                      fontSize: 9,
                      bold: true,
                      color: C.red,
                      fillColor: C.redSoft,
                      margin: [10, 7, 10, 7],
                    },
                  ],
                ],
              },
              layout: "noBorders",
              margin: [0, 0, 0, 12],
            },
          ]
        : []),

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
            ...inventoryRows,
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

      /* survey inventory — full room-grouped item list from the survey */
      ...(surveyInventorySection.length
        ? [{ text: "SURVEY INVENTORY", style: "colHead", color: C.red, margin: [0, 0, 0, 8] }]
        : []),
      ...surveyInventorySection,

      /* survey walkthrough videos — QR to the job page */
      ...videoSection,

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

      ...photoSection,
    ],
  };
}
