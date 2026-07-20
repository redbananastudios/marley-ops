/**
 * The night-before crew DAY SHEET — one A4 brief covering every job a crew
 * member is on that day. Rendered server-side (lib/pdf/server-pdf.ts) for the
 * emailed PDF; the same data drives the /sheet/[token] web view.
 *
 * Price-free like every crew-facing surface. Tables/text only (no images or
 * QR) so it renders fast and reliably in a cron with no browser.
 *
 * Pure builder — tests walk the doc-def directly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { CrewDaySheet, DailyJob } from "./daily-data";

const C = {
  red: "#C03838",
  redSoft: "#FDF1F1",
  ink: "#1F1D1B",
  charcoal: "#2A2927",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  amber: "#B45309",
  amberSoft: "#FEF3E2",
  white: "#FFFFFF",
};

export interface DaySheetMeta {
  /** 1 for the first send; higher when re-issued after a job changed. */
  version: number;
  /** true when version > 1 — renders the "supersedes earlier sheet" banner. */
  supersedes: boolean;
  /** "18:04 on Sun 20 Jul" — when this copy was generated. */
  generatedAtLabel: string;
}

const fmtDate = (d: string): string => {
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? d
    : t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

const kindLabel = (apptType: string): string => (apptType === "removal" ? "Move" : apptType === "survey" ? "Survey" : apptType);

function addrBlock(title: string, a: DailyJob["sheet"]["from"]): any {
  const accessBits = [
    a.propertyType || null,
    a.floor && a.floor !== "ground" ? `floor: ${a.floor}` : a.propertyType ? "ground floor" : null,
    a.lift === "yes" ? "lift" : null,
    a.accessM > 0 ? `carry ~${a.accessM}m` : null,
  ].filter(Boolean);
  return {
    width: "*",
    stack: [
      { text: title.toUpperCase(), style: "miniLabel" },
      { text: a.address || "—", style: "addr", margin: [0, 2, 0, 0] },
      { text: a.postcode || "", style: "postcode" },
      accessBits.length ? { text: accessBits.join(" · "), style: "meta", margin: [0, 2, 0, 0] } : { text: "" },
    ],
  };
}

function jobCard(job: DailyJob, index: number, total: number): any {
  const s = job.sheet;
  const otherCrew = s.crew.length ? s.crew : [];
  const vehicles = s.vehicles.length ? s.vehicles : s.vehicleLabel ? [`Required: ${s.vehicleLabel}`] : [];
  const inventory = s.items.length ? s.items.map((i) => `${i.label} × ${i.qty}`) : [];
  const notes = [
    s.accessNotes ? `Access: ${s.accessNotes}` : null,
    s.largeItemsNotes ? `Large items: ${s.largeItemsNotes}` : null,
    s.jobNotes || null,
  ].filter(Boolean) as string[];

  const detailRow = (label: string, lines: string[]): any =>
    lines.length
      ? {
          columns: [
            { width: 88, text: label.toUpperCase(), style: "miniLabel", margin: [0, 1, 0, 0] },
            { width: "*", stack: lines.map((l) => ({ text: l, style: "body" })) },
          ],
          margin: [0, 3, 0, 0],
        }
      : null;

  // Survey photos — access shots / large items — two per row, small thumbnails.
  const photos = s.photos ?? [];
  const photoCell = (p: { dataUri: string; label: string; caption: string }): any => ({
    width: "*",
    stack: [
      { image: p.dataUri, fit: [232, 165] },
      { text: p.caption ? `${p.label} — ${p.caption}` : p.label, style: "meta", margin: [0, 2, 0, 0] },
    ],
  });
  const photoRows: any[] = [];
  for (let i = 0; i < photos.length; i += 2) {
    photoRows.push({
      columns: [photoCell(photos[i]), { width: 10, text: "" }, photos[i + 1] ? photoCell(photos[i + 1]) : { width: "*", text: "" }],
      margin: [0, 6, 0, 0],
    });
  }
  const photoSection: any[] = photos.length
    ? [{ text: "PHOTOS", style: "miniLabel", margin: [0, 8, 0, 0] }, ...photoRows]
    : [];

  return {
    unbreakable: false,
    table: {
      widths: ["*"],
      body: [
        // header strip: window · kind · #
        [
          {
            columns: [
              {
                width: "*",
                text: [
                  { text: job.window, style: "cardTime" },
                  { text: `   ${kindLabel(job.apptType)}`, style: "cardKind" },
                ],
              },
              { width: "auto", text: `Job ${index + 1} of ${total}`, style: "cardCount", alignment: "right" },
            ],
            fillColor: C.charcoal,
            margin: [12, 8, 12, 8],
          },
        ],
        // body
        [
          {
            fillColor: C.white,
            margin: [12, 10, 12, 12],
            stack: [
              {
                columns: [
                  { width: "*", text: s.customerName || "Customer", style: "custName" },
                  { width: "auto", text: s.customerPhone ?? "no phone on file", style: "custPhone", alignment: "right" },
                ],
              },
              s.quoteRef ? { text: s.quoteRef, style: "meta", margin: [0, 1, 0, 0] } : { text: "" },
              s.contractSigned === false
                ? {
                    text: "Contract not yet signed — collect the customer's signature on arrival.",
                    style: "warn",
                    margin: [0, 6, 0, 0],
                  }
                : { text: "" },
              {
                columns: [addrBlock("Moving from", s.from), { width: 14, text: "" }, addrBlock("Moving to", s.to)],
                margin: [0, 8, 0, 2],
              },
              detailRow("Vehicle", vehicles) ?? { text: "" },
              detailRow("Crew", otherCrew) ?? { text: "" },
              detailRow("Packing", s.packingLabel ? [s.packingLabel] : []) ?? { text: "" },
              detailRow("Inventory", inventory) ?? { text: "" },
              detailRow("Notes", notes) ?? { text: "" },
              ...photoSection,
            ].filter(Boolean),
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
    margin: [0, 0, 0, 12],
  };
}

export function buildDaySheetDocDef(day: CrewDaySheet, meta: DaySheetMeta): any {
  const firstName = (day.crew.fullName || "").trim().split(/\s+/)[0] || day.crew.fullName;
  const total = day.jobs.length;

  const supersedeBanner = meta.supersedes
    ? [
        {
          table: {
            widths: ["*"],
            body: [
              [
                {
                  text: `UPDATED SHEET (version ${meta.version}) — this replaces the sheet we sent you earlier. A job changed. Generated ${meta.generatedAtLabel}.`,
                  style: "banner",
                  fillColor: C.amberSoft,
                  margin: [12, 8, 12, 8],
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
    info: { title: `Marley Moves Day Sheet — ${day.crew.fullName} — ${day.workDate}`, author: "Marley Moves Ltd", creator: "Marley Ops" },
    pageSize: "A4",
    pageMargins: [38, 38, 38, 46],
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
      hero: { fontSize: 15, bold: true, color: C.white },
      heroSub: { fontSize: 9.5, color: "#F4D9D9" },
      banner: { fontSize: 9, bold: true, color: C.amber },
      miniLabel: { fontSize: 7.5, bold: true, color: C.red, characterSpacing: 0.6 },
      cardTime: { fontSize: 11, bold: true, color: C.white },
      cardKind: { fontSize: 9.5, color: "#E8D6D6" },
      cardCount: { fontSize: 8.5, color: "#CFC9C4" },
      custName: { fontSize: 12, bold: true, color: C.ink },
      custPhone: { fontSize: 11, bold: true, color: C.red },
      addr: { fontSize: 10, bold: true, color: C.ink },
      postcode: { fontSize: 11, bold: true, color: C.red, margin: [0, 1, 0, 0] },
      body: { fontSize: 9.5, color: C.ink },
      meta: { fontSize: 8.5, color: C.muted },
      warn: { fontSize: 8.8, bold: true, color: C.red },
      footerText: { fontSize: 7.5, color: C.muted },
      empty: { fontSize: 10, color: C.muted },
    },
    content: [
      {
        columns: [
          { text: [{ text: "MARLEY ", style: "brand" }, { text: "MOVES", style: ["brand", "brandRed"] }] },
          { text: "DAY SHEET", style: "docTitle", alignment: "right", margin: [0, 7, 0, 0] },
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 519, y2: 0, lineWidth: 1, lineColor: C.border }], margin: [0, 8, 0, 12] },

      ...supersedeBanner,

      // hero — who + when
      {
        table: {
          widths: ["*", "auto"],
          body: [
            [
              {
                stack: [
                  { text: `${firstName}'s jobs`, style: "hero" },
                  { text: `${total} ${total === 1 ? "job" : "jobs"} · version ${meta.version}`, style: "heroSub", margin: [0, 2, 0, 0] },
                ],
                fillColor: C.charcoal,
                margin: [14, 11, 14, 11],
              },
              {
                stack: [{ text: fmtDate(day.workDate), style: "hero", alignment: "right" }],
                fillColor: C.charcoal,
                margin: [14, 11, 14, 11],
              },
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 12],
      },

      ...(total === 0
        ? [{ text: "No jobs assigned for this day.", style: "empty" }]
        : day.jobs.map((job, i) => jobCard(job, i, total))),
    ],
  };
}
