/**
 * Server-side PDF rendering. The rest of the app builds PDFs in the browser
 * (window.pdfMake, loaded from a CDN by <PdfLoader/>) — fine when a human is
 * looking at a page, useless in a cron. The night-before crew job-sheet
 * dispatch (app/api/cron/crew-job-sheets) has no browser, so it renders the
 * same pdfmake doc-defs here with pdfmake's Node printer.
 *
 * Fonts are embedded as Buffers (lib/pdf/fonts-data.ts) rather than read from
 * disk: a computed fs path is not picked up by Next's standalone output-file
 * tracing, so the .ttf would be missing in the Docker image. Base64-in-bundle
 * always ships.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import PdfPrinter from "pdfmake";
import { MontserratRegular, MontserratBold, CormorantRegular, CormorantBold } from "./fonts-data";

const buf = (b64: string): Buffer => Buffer.from(b64, "base64");

// Same family names the client vfs registers, so a doc-def written for the
// browser renders identically here. Montserrat covers body/medium/bold/italic
// (italics fall back to the regular/bold cut — the sheets never italicise);
// Cormorant is the brand wordmark only.
const FONTS = {
  Montserrat: {
    normal: buf(MontserratRegular),
    bold: buf(MontserratBold),
    italics: buf(MontserratRegular),
    bolditalics: buf(MontserratBold),
  },
  Cormorant: {
    normal: buf(CormorantRegular),
    bold: buf(CormorantBold),
    italics: buf(CormorantRegular),
    bolditalics: buf(CormorantBold),
  },
} as const;

// One printer instance is enough — it holds only the font descriptors.
let printer: PdfPrinter | null = null;
function getPrinter(): PdfPrinter {
  if (!printer) printer = new PdfPrinter(FONTS as any);
  return printer;
}

/** Render a pdfmake document definition to a PDF Buffer (server, no browser). */
export function renderPdfBuffer(docDef: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = getPrinter().createPdfKitDocument(docDef);
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Render to base64 (no `data:` prefix) — the shape Resend attachments want. */
export async function renderPdfBase64(docDef: any): Promise<string> {
  return (await renderPdfBuffer(docDef)).toString("base64");
}
