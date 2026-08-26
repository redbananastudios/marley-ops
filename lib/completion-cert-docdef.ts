/**
 * Completion certificate — the customer's "everything delivered" receipt,
 * generated at the doorstep sign-off and emailed with both signatures baked
 * in (Peter, 2026-07-10). Pure doc-def builder (tests walk it); rendered
 * client-side on the crew device by window.pdfMake, same pipeline as the job
 * sheet. Price-free: money never appears on completion paperwork.
 *
 * pdfmake trap reminders (lessons-learned): defaultStyle.font MUST name a vfs
 * font (no Roboto here) and any colSpan filler cell must stay a bare {}.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DocBrand } from "@/lib/pdf/doc-brand";

const C = {
  red: "#C03838",
  ink: "#1F1D1B",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  okBg: "#F1F7F1",
  ok: "#2F7A3D",
  warnBg: "#FDF6EC",
  warn: "#9A6B15",
  white: "#FFFFFF",
};

export interface CompletionCertData {
  quoteRef: string | null;
  customerName: string;
  moveDate: string | null; // yyyy-mm-dd
  from: string; // "address, POSTCODE"
  to: string;
  crewName: string;
  crewSignature: string; // PNG data URI
  customerSignature: string | null; // null when absent
  customerAbsent: boolean;
  absentReason: string;
  exceptions: string; // "" = nothing to report
  signedAtLabel: string; // "16:42 on Friday, 10 July 2026"
  /** The job's brand (multi-brand PRD §3.6 — the cert is a JOB document).
   *  Absent/null renders today's default-brand literals, byte-identical. */
  brand?: DocBrand | null;
}

const fmtDate = (d: string | null): string => {
  if (!d) return "—";
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? "—"
    : t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

function fact(label: string, value: string): any[] {
  return [
    { text: label, style: "factLabel", margin: [0, 3, 10, 3] },
    { text: value || "—", style: "factValue", margin: [0, 3, 0, 3] },
  ];
}

function signatureBlock(title: string, name: string, dataUri: string | null, note: string, accent: string): any {
  return {
    stack: [
      { text: title, style: "colHead", color: accent, margin: [0, 0, 0, 6] },
      dataUri
        ? { image: dataUri, fit: [200, 60], margin: [0, 0, 0, 4] }
        : { text: "Not signed", italics: true, color: C.muted, fontSize: 9, margin: [0, 20, 0, 24] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.75, lineColor: C.ink }] },
      { text: name, bold: true, fontSize: 10, margin: [0, 4, 0, 1] },
      { text: note, style: "meta" },
    ],
    border: [false, false, false, false],
  };
}

export function buildCompletionCertDocDef(d: CompletionCertData): any {
  const hasExceptions = d.exceptions.trim().length > 0;
  // Data rule, never a slug switch: no brand → today's constants (byte-parity);
  // a brand → its WCAG-picked colour and row-sourced identity lines.
  const accent = d.brand?.colour ?? C.red;
  const brandName = d.brand?.name ?? "Marley Moves";

  return {
    pageSize: "A4",
    pageMargins: [40, 42, 40, 46],
    defaultStyle: { font: "Montserrat", fontSize: 9.5, color: C.ink, lineHeight: 1.25 },
    styles: {
      brand: { font: "Cormorant", fontSize: 24, bold: true },
      docTitle: { fontSize: 12, bold: true, characterSpacing: 1.5 },
      colHead: { fontSize: 8, bold: true, characterSpacing: 1 },
      factLabel: { fontSize: 8, bold: true, color: C.muted, characterSpacing: 0.5 },
      factValue: { fontSize: 10, bold: true },
      meta: { fontSize: 7.5, color: C.muted },
      body: { fontSize: 9.5 },
    },
    content: [
      // header — the two-tone wordmark is the default brand's design; any
      // other brand renders its full name in its own colour with the group
      // disclosure beside it (required wherever the brand identity appears).
      {
        columns: [
          d.brand
            ? {
                stack: [
                  { text: d.brand.name.toUpperCase(), style: "brand", color: accent },
                  { text: d.brand.groupLine, style: "meta", margin: [0, 2, 0, 0] },
                ],
                width: "*",
              }
            : { text: [{ text: "MARLEY ", style: "brand" }, { text: "MOVES", style: "brand", color: C.red }], width: "*" },
          {
            stack: [
              { text: "CERTIFICATE OF COMPLETION", style: "docTitle", color: accent, alignment: "right" },
              ...(d.quoteRef
                ? [{ text: `Quote ${d.quoteRef}`, style: "meta", alignment: "right", margin: [0, 3, 0, 0] }]
                : []),
            ],
            width: "auto",
          },
        ],
        margin: [0, 0, 0, 6],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.25, lineColor: accent }], margin: [0, 0, 0, 16] },

      // job facts
      {
        table: {
          widths: [110, "*"],
          body: [
            fact("CUSTOMER", d.customerName),
            fact("MOVE DATE", fmtDate(d.moveDate)),
            fact("FROM", d.from),
            fact("TO", d.to),
            fact("COMPLETED", d.signedAtLabel),
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 14],
      },

      // declaration
      {
        text: d.customerAbsent
          ? `The removal described above has been completed by ${brandName}. No customer or representative was available to sign at the destination — please check your delivered items and reply to the accompanying email within 48 hours if anything is missing or damaged.`
          : `The removal described above has been completed by ${brandName}. By signing, the customer confirms all items were delivered and received, subject only to any exceptions noted below.`,
        style: "body",
        margin: [0, 0, 0, 12],
      },

      // exceptions panel
      {
        table: {
          widths: ["*"],
          body: [
            [
              {
                stack: [
                  { text: "EXCEPTIONS", style: "colHead", color: hasExceptions ? C.warn : C.ok, margin: [0, 0, 0, 4] },
                  {
                    text: hasExceptions ? d.exceptions.trim() : "Nothing to report — all items delivered in good order.",
                    fontSize: 9.5,
                    color: hasExceptions ? C.ink : C.ok,
                  },
                ],
                fillColor: hasExceptions ? C.warnBg : C.okBg,
                margin: [12, 10, 12, 10],
                border: [false, false, false, false],
              },
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 18],
      },

      // absent reason (only when absent)
      ...(d.customerAbsent
        ? [
            {
              text: `Customer not present at completion — reason recorded: ${d.absentReason.trim() || "not given"}.`,
              style: "meta",
              margin: [0, 0, 0, 14] as any,
            },
          ]
        : []),

      // signatures
      {
        table: {
          widths: ["*", 30, "*"],
          body: [
            [
              signatureBlock(
                "CUSTOMER",
                d.customerAbsent ? "Not present" : d.customerName,
                d.customerAbsent ? null : d.customerSignature,
                d.customerAbsent ? "" : `Signed ${d.signedAtLabel}`,
                accent,
              ),
              { text: "", border: [false, false, false, false] },
              signatureBlock(`CREW LEAD — ${brandName.toUpperCase()}`, d.crewName, d.crewSignature, `Signed ${d.signedAtLabel}`, accent),
            ],
          ],
        },
        layout: "noBorders",
        margin: [0, 6, 0, 0],
      },

      // footer — legal-entity line + contact from the brands row; the default
      // brand keeps today's literal exactly.
      {
        text: d.brand
          ? [d.brand.legalLine, d.brand.phone, d.brand.email].filter(Boolean).join(" · ")
          : "Marley Moves Ltd · Company No. 15914266 · 01747 637070 · hello@marleymoves.co.uk",
        style: "meta",
        alignment: "center",
        margin: [0, 34, 0, 0],
      },
    ],
  };
}
