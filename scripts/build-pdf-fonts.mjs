// Regenerates lib/pdf/fonts-data.ts — the base64-embedded TrueType fonts the
// SERVER-side PDF printer (lib/pdf/server-pdf.ts) uses. We embed rather than
// read from disk so the fonts travel inside the JS bundle and survive Next's
// standalone output-file-tracing (a computed fs path is not traced).
//
// Source of truth is public/fonts/vfs_fonts.js (the client pdfmake VFS). This
// script decodes the four families the crew job sheet needs and rewrites the
// data module. Run:  node scripts/build-pdf-fonts.mjs
import fs from "node:fs";

global.window = {};
await import("../public/fonts/vfs_fonts.js");
const vfs = global.window.pdfMake.vfs;

const files = {
  MontserratRegular: "Montserrat-Regular.ttf",
  MontserratBold: "Montserrat-Bold.ttf",
  CormorantRegular: "CormorantGaramond-Regular.ttf",
  CormorantBold: "CormorantGaramond-Bold.ttf",
};

let out = `// GENERATED — do not edit by hand.\n`;
out += `// Base64-embedded TrueType fonts for the SERVER-side PDF printer\n`;
out += `// (lib/pdf/server-pdf.ts). Regenerate from public/fonts/vfs_fonts.js with\n`;
out += `// scripts/build-pdf-fonts.mjs. Embedded (not read from disk) so the fonts\n`;
out += `// travel inside the JS bundle and survive Next standalone file-tracing.\n\n`;
for (const [key, name] of Object.entries(files)) {
  const b64 = vfs[name];
  if (!b64) throw new Error(`Font ${name} not found in vfs_fonts.js`);
  out += `export const ${key} = "${b64}";\n`;
}
fs.writeFileSync(new URL("../lib/pdf/fonts-data.ts", import.meta.url), out);
console.log("wrote lib/pdf/fonts-data.ts");
