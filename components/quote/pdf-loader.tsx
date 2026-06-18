"use client";

/**
 * Loads pdfmake + its vfs fonts onto window.pdfMake so the client-side PDF
 * module (@/lib/quote/pdf-client) can build + download the customer quote PDF.
 *
 * Order matters: pdfmake.min.js must be present before vfs_fonts.js runs (the
 * fonts file wires pdfMake.vfs + pdfMake.fonts). We gate the fonts <Script> on
 * the core script's onLoad so it never executes against an undefined pdfMake.
 *
 * Render this ONCE in the quote builder page. next/script dedupes by id, so a
 * second mount is harmless.
 */

import Script from "next/script";
import { useState } from "react";

const PDFMAKE_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js";
const VFS_SRC = "/fonts/vfs_fonts.js";

export function PdfLoader() {
  // Only inject the fonts script once the core pdfmake bundle has loaded.
  const [coreReady, setCoreReady] = useState(false);

  return (
    <>
      <Script
        id="pdfmake-core"
        src={PDFMAKE_SRC}
        strategy="lazyOnload"
        onLoad={() => setCoreReady(true)}
      />
      {coreReady && (
        <Script id="pdfmake-vfs" src={VFS_SRC} strategy="lazyOnload" />
      )}
    </>
  );
}

export default PdfLoader;
