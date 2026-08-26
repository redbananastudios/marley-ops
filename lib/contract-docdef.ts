/**
 * The signed contract as a document — the thing an insurer, a solicitor or a
 * customer in dispute actually asks for. Until now the evidence existed only as
 * a rendered panel in the office UI, so producing "the signed contract" meant
 * screenshotting a page (Peter, 2026-08-11).
 *
 * It is built ON DEMAND from the signature row rather than generated and stored
 * at signing. Everything it renders is already immutable: the terms text and
 * its hash, the acknowledgment wording, the signature and the timestamp are all
 * captured on the row (migration 0093). A stored PDF would be a second copy of
 * facts we already hold, with its own way of going missing — and generating one
 * at signing would put a PDF render on the customer's accept path, where a
 * failure would either block the signature or leave a contract with no document.
 * Deterministic regeneration from immutable inputs is the stronger guarantee.
 *
 * Pure doc-def builder, so the tests can walk it. Rendered by
 * lib/pdf/server-pdf.ts.
 *
 * pdfmake trap reminders (lessons-learned): defaultStyle.font MUST name a vfs
 * font (no Roboto here) or createPdf hangs, and colSpan filler cells stay bare.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DocBrand } from "@/lib/pdf/doc-brand";

const C = {
  red: "#C03838",
  ink: "#1F1D1B",
  muted: "#6F6A64",
  border: "#E8E3DC",
  softPanel: "#FBF8F4",
  white: "#FFFFFF",
};

export interface ContractDocData {
  /** "Contract", "Date confirmation", "Storage agreement" — what this IS. */
  documentTitle: string;
  quoteRef: string | null;
  customerName: string;
  moveDate: string | null;
  from: string;
  to: string;
  priceLabel: string | null;
  signerName: string;
  /** PNG data URI when drawn; null when typed (the typed name IS the signature). */
  signatureImage: string | null;
  method: string;
  channel: string;
  signedAtLabel: string;
  collectedByName: string | null;
  ip: string | null;
  /** key -> { label, ticked } — wording captured at signing, not today's. */
  acknowledgments: { label: string; ticked: boolean }[];
  termsTitle: string;
  termsVersionId: string;
  termsSha256: string;
  /** The full terms markdown as served. Rendered as the body of the document. */
  termsBody: string;
  /** True when the terms have not yet been through a solicitor. */
  legalReviewPending: boolean;
  /** The job's brand (multi-brand PRD §3.6 — a contract is a JOB document).
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

/**
 * Render the stored markdown into pdfmake content.
 *
 * Deliberately a small subset (headings, bullets, paragraphs, bold) rather than
 * a markdown library: the input is not arbitrary, it is our own published
 * documents, and anything it cannot style still appears as readable text. The
 * words are what matter here, not the typography.
 */
export function termsToContent(markdown: string): any[] {
  const out: any[] = [];
  const bold = (text: string): any => {
    const parts = text.split(/\*\*(.+?)\*\*/g);
    if (parts.length === 1) return { text, style: "terms" };
    return { text: parts.map((p, i) => (i % 2 ? { text: p, bold: true } : { text: p })), style: "terms" };
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      out.push({ text: line.slice(3), style: "termsHead", margin: [0, 10, 0, 4] });
    } else if (line.startsWith("# ")) {
      out.push({ text: line.slice(2), style: "termsHead", margin: [0, 10, 0, 4] });
    } else if (/^[-*]\s+/.test(line)) {
      out.push({ ul: [bold(line.replace(/^[-*]\s+/, ""))], style: "terms", margin: [0, 1, 0, 1] });
    } else if (/^\d+\.\s+/.test(line)) {
      out.push({ ol: [bold(line.replace(/^\d+\.\s+/, ""))], style: "terms", margin: [0, 1, 0, 1] });
    } else {
      out.push({ ...bold(line), margin: [0, 2, 0, 2] });
    }
  }
  return out;
}

export function buildContractDocDef(d: ContractDocData): any {
  // Data rule, never a slug switch: no brand → today's constants (byte-parity);
  // a brand → its WCAG-picked colour and row-sourced identity lines.
  const accent = d.brand?.colour ?? C.red;
  const tick = (ok: boolean) => ({
    text: ok ? "YES" : "NOT TICKED",
    color: ok ? C.ink : accent,
    bold: true,
    fontSize: 8,
  });

  return {
    pageSize: "A4",
    pageMargins: [40, 44, 40, 56],
    defaultStyle: { font: "Montserrat", fontSize: 9.5, color: C.ink, lineHeight: 1.35 },
    footer: (page: number, count: number) => ({
      columns: [
        { text: `${d.documentTitle} · ${d.quoteRef ?? ""} · ${d.signerName}`, style: "footer" },
        { text: `Page ${page} of ${count}`, style: "footer", alignment: "right" },
      ],
      margin: [40, 16, 40, 0],
    }),
    content: [
      { text: (d.brand?.name ?? "MARLEY MOVES").toUpperCase(), font: "Cormorant", fontSize: 20, color: accent, margin: [0, 0, 0, 2] },
      // Group disclosure + legal-entity line beside the brand identity — a
      // second brand is a trading name, and a contract must say whose.
      ...(d.brand
        ? [
            {
              text: [d.brand.groupLine, d.brand.legalLine].filter(Boolean).join("  ·  "),
              style: "meta",
              margin: [0, 0, 0, 6],
            },
          ]
        : []),
      { text: d.documentTitle.toUpperCase(), style: "docTitle", margin: [0, 0, 0, 10] },

      // What was agreed, at a glance.
      {
        table: {
          widths: ["auto", "*"],
          // Each fact() IS a row of two cells. Spreading them turns every row
          // into two single-cell rows and pdfmake dies on the missing column.
          body: [
            fact("Customer", d.customerName),
            ...(d.quoteRef ? [fact("Quote reference", d.quoteRef)] : []),
            ...(d.moveDate ? [fact("Move date", fmtDate(d.moveDate))] : []),
            ...(d.from ? [fact("From", d.from)] : []),
            ...(d.to ? [fact("To", d.to)] : []),
            ...(d.priceLabel ? [fact("Agreed price", d.priceLabel)] : []),
          ],
        },
        layout: "noBorders",
        margin: [0, 0, 0, 12],
      },

      // The evidence pack. This is the part that answers "who agreed, to what,
      // when, and how do we know the text has not changed since".
      {
        table: {
          widths: ["*"],
          body: [
            [
              {
                stack: [
                  { text: "SIGNATURE", style: "colHead", color: accent, margin: [0, 0, 0, 6] },
                  d.signatureImage
                    ? { image: d.signatureImage, fit: [200, 55], margin: [0, 0, 0, 4] }
                    : { text: d.signerName, font: "Cormorant", fontSize: 20, margin: [0, 2, 0, 6] },
                  { canvas: [{ type: "line", x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.75, lineColor: C.ink }] },
                  { text: d.signerName, bold: true, fontSize: 10, margin: [0, 4, 0, 1] },
                  {
                    text:
                      `Signed ${d.channel === "in_person" ? `in person on a ${d.brand?.shortName ?? "Marley Moves"} device` : "online"}` +
                      `${d.collectedByName ? ` (collected by ${d.collectedByName})` : ""}` +
                      ` · ${d.method === "drawn" ? "drawn" : "typed"} signature · ${d.signedAtLabel}` +
                      `${d.ip ? ` · from ${d.ip}` : ""}`,
                    style: "meta",
                  },
                  {
                    text: `Terms agreed: ${d.termsVersionId}`,
                    style: "meta",
                    margin: [0, 3, 0, 0],
                  },
                  { text: `Document fingerprint (SHA-256): ${d.termsSha256}`, style: "hash" },
                ],
                fillColor: C.softPanel,
                margin: [12, 10, 12, 10],
                border: [true, true, true, true],
              },
            ],
          ],
        },
        layout: {
          hLineColor: () => C.border,
          vLineColor: () => C.border,
          hLineWidth: () => 0.75,
          vLineWidth: () => 0.75,
        },
        margin: [0, 0, 0, 12],
      },

      // The tick-boxes, in the wording shown at the time.
      ...(d.acknowledgments.length
        ? [
            { text: "WHAT THE CUSTOMER CONFIRMED", style: "colHead", color: accent, margin: [0, 0, 0, 5] },
            {
              table: {
                widths: ["auto", "*"],
                body: d.acknowledgments.map((a) => [
                  { ...tick(a.ticked), margin: [0, 3, 8, 3] },
                  { text: a.label, style: "terms", margin: [0, 3, 0, 3] },
                ]),
              },
              layout: "noBorders",
              margin: [0, 0, 0, 14],
            },
          ]
        : []),

      // The terms themselves, as served. This is what makes the PDF a contract
      // rather than a receipt for one.
      { text: d.termsTitle.toUpperCase(), style: "docTitle", pageBreak: "before", margin: [0, 0, 0, 2] },
      {
        text: `Version ${d.termsVersionId}. This is the text as it stood when ${d.signerName} signed.`,
        style: "meta",
        margin: [0, 0, 0, 10],
      },
      ...termsToContent(d.termsBody),

      ...(d.legalReviewPending
        ? [
            {
              text: "These terms have not yet been reviewed by a solicitor.",
              style: "meta",
              color: C.muted,
              margin: [0, 14, 0, 0],
            },
          ]
        : []),
    ],
    styles: {
      docTitle: { fontSize: 13, bold: true, characterSpacing: 1.1, color: C.ink },
      colHead: { fontSize: 8, bold: true, characterSpacing: 0.8 },
      factLabel: { fontSize: 8, color: C.muted, characterSpacing: 0.5 },
      factValue: { fontSize: 10, bold: true },
      meta: { fontSize: 8, color: C.muted },
      hash: { fontSize: 6.5, color: C.muted },
      terms: { fontSize: 9, color: C.ink },
      termsHead: { fontSize: 10.5, bold: true, color: C.ink },
      footer: { fontSize: 7, color: C.muted },
    },
  };
}
