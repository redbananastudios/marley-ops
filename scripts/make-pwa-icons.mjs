// Regenerate Marley Ops PWA icons from the canonical full-colour brandmark.
// The source has huge transparent padding — trim to the mark, then compose at
// the right scale per icon purpose:
//   any icons      mark ~84% of tile on white (fills the home-screen tile)
//   maskable       mark ~64% of tile (survives circle/squircle masks)
//   apple-touch    180px, mark ~80%, flattened white (iOS hates transparency)
import sharp from "sharp";
import { mkdirSync } from "fs";

const SRC =
  "O:/projects/red-banana/clients/marley/logos/Digital/Brandmark/Full-Colour/PNG File/Brandmark - Full-Colour - Large.png";
const OUT = "O:/projects/red-banana/clients/marley/marley-ops-emails/public/icons";
mkdirSync(OUT, { recursive: true });

const trimmed = await sharp(SRC).trim().png().toBuffer();

async function make(file, size, markPct) {
  const markSize = Math.round(size * markPct);
  const mark = await sharp(trimmed)
    .resize(markSize, markSize, { fit: "inside" })
    .png()
    .toBuffer();
  const meta = await sharp(mark).metadata();
  await sharp({
    create: { width: size, height: size, channels: 4, background: "#ffffff" },
  })
    .composite([
      {
        input: mark,
        left: Math.round((size - meta.width) / 2),
        top: Math.round((size - meta.height) / 2),
      },
    ])
    .png()
    .toFile(`${OUT}/${file}`);
  console.log(`${file}: ${size}px, mark ${meta.width}x${meta.height}`);
}

await make("icon-192.png", 192, 0.84);
await make("icon-512.png", 512, 0.84);
await make("icon-maskable-192.png", 192, 0.64);
await make("icon-maskable-512.png", 512, 0.64);
await make("apple-touch-icon.png", 180, 0.8);
console.log("done");
