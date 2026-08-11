# Self-hosted webfonts

These are downloaded, not fetched at build time. `next/font/google` reaches
fonts.googleapis.com during `npm run build`, and on 2026-08-11 that fetch failed
inside the Docker build and took the staging deploy down with a "module not
found" on `geist_*.module.css` — a network problem wearing a code error's
clothes. It passed on re-run, which is exactly why it needed fixing: the release
path depended on a third party being up.

Regenerate (only when adding a face or widening a weight range):

    node scripts/fetch-fonts.mjs

| File | Family | Weights | Used for |
|---|---|---|---|
| `geist-latin.woff2` | Geist | 400–700 (variable) | `--font-geist` → body + `.font-display` |
| `geist-mono-latin.woff2` | Geist Mono | 400–600 (variable) | `--font-geist-mono` → `--font-mono` |
| `cormorant-garamond-latin.woff2` | Cormorant Garamond | 500–700 (variable) | `--font-cormorant` → `.font-brand` wordmark |

Latin subset only, matching the `subsets: ["latin"]` these already declared.
Variable files, so every weight in the range is available for 88KB total.

`public/fonts/` is a different thing: `vfs_fonts.js` embeds TTFs for pdfmake
(PDF generation) and `great-vibes.woff2` is loaded by a plain `@font-face` in
globals.css. Leave those alone.

**Licence:** all three are SIL Open Font License 1.1, but under two different
copyright holders, so the licences are filed separately rather than merged:
`OFL-Geist.txt` (Geist + Geist Mono, The Geist Project Authors / Vercel) and
`OFL-CormorantGaramond.txt` (The Cormorant Project Authors / Catharsis Fonts).
The OFL permits bundling and redistribution as part of a larger work; it forbids
selling the fonts on their own and requires the licence to travel with them,
which is why both files are committed alongside the woff2s.
