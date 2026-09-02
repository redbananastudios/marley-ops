#!/usr/bin/env node
/**
 * Brand-leak scan — the SOURCE half (multi-brand PRD §6 addition 4; §10
 * "Where the brand-leak scan lives").
 *
 * A "brand-resolved" file is one whose output is meant to be correct for ANY
 * brand because everything brand-specific arrives as data from the `brands`
 * table. Such a file may not contain ANY brand's literals — not the default
 * brand's, not the second brand's — in code OR comments. One hardcoded name,
 * domain, phone number or brand-colour token in a shared template is exactly
 * the class of leak this catches mechanically (the office phone number
 * appears nine times in /q alone; the class is what matters, not the
 * instance).
 *
 * THE MANIFEST GROWTH CONTRACT: only files matched by MANIFEST are scanned.
 * A file not listed is NOT clean — it is UNSCANNED. As each gate brands a
 * surface (converts its hardcoded identity to `brands`-table reads), that
 * gate adds the newly brand-resolved paths to MANIFEST in the same PR, so the
 * scan's coverage grows in lockstep with the refactor and a later edit can
 * never quietly re-hardcode a literal. Never remove an entry to get a run
 * green — fix the leak (PRD §10: leak hits in existing code are findings to
 * fix in the same gate).
 *
 * SHARED-SURFACE ENTRIES: some brand-resolved files are shared surfaces —
 * both brands' records render through them — that deliberately keep Marley
 * APP CHROME (PRD §2 "App chrome — unchanged": the mm-red toolbar, today
 * ring, now-indicator and control tints belong to the frame, not the
 * records). A blanket literal ban would flag chrome the PRD mandates, so a
 * manifest entry may be `{ pattern, allow, reason }`: the named literals are
 * exempt IN THAT ENTRY'S FILES ONLY, everything else stays forbidden both
 * directions. The exemption is evidence-disciplined, mirroring the
 * dead-pattern rule: an allow literal that is not in FORBIDDEN is an ERROR
 * (a typo would otherwise suppress nothing, silently, forever), and an allow
 * literal that no longer occurs under its pattern is an ERROR — so fixing
 * the underlying literal forces the allow's removal in the same change, and
 * an exemption can never outlive its justification.
 *
 * THE SPLIT (PRD §10): this script is the source grep. The RENDERED-PAGE half
 * is `e2e/public/brand-leak-rendered.spec.ts` — a Playwright assertion that
 * seeds a second-brand quote, storage let and cubic survey, opens `/q`, `/s`
 * and `/cv`, and scans the post-hydration DOM for the same literal list this
 * file uses (imported from ./brand-leak-literals.mjs, so the two halves cannot
 * drift). Neither half caps or substitutes for the other, and the asymmetry is
 * the point: a grep cannot see a literal that arrives through a token, a
 * database row or a Tailwind class re-pointed at runtime, and the rendered
 * check cannot see a file no page happens to render. So a clean run HERE still
 * says nothing about what the pages actually rendered — read this file's OK
 * line and that spec's result together, never either alone.
 *
 * Evidence discipline (house rule: "I could not check" must never render as
 * "nothing to report"): a manifest pattern that matches no files is an ERROR,
 * and a run that scanned zero files FAILS — a scan that scanned nothing must
 * never print clean.
 *
 * This script necessarily names every forbidden literal (via the shared module
 * it re-exports), so neither it nor `scripts/brand-leak-literals.mjs` may ever
 * be added to MANIFEST. The vitest twin (tests/brand-leak-scan.test.ts) imports
 * and runs the same check so it rides `npm test` with no package.json change;
 * run standalone with `node scripts/brand-leak-scan.mjs`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The literal list and the detector live in a SEPARATE module, and the reason
 * is the two `import.meta.url` uses in this file. Playwright transpiles a spec
 * and everything it imports to CommonJS, where `import.meta` is a load-time
 * syntax error — so the rendered half (e2e/public/brand-leak-rendered.spec.ts)
 * cannot import from here at all. Rather than let it keep a second copy of the
 * list, the shared parts moved to a module with no filesystem awareness. They
 * are re-exported below so this file's existing importers — the vitest twin,
 * and anything reading `FORBIDDEN` off the scan — are unchanged.
 */
import { FORBIDDEN, findLeaksInContent } from "./brand-leak-literals.mjs";

export { FORBIDDEN, findLeaksInContent };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Brand-resolved source globs, repo-relative with forward slashes. Grows gate
 * by gate — see THE MANIFEST GROWTH CONTRACT above. Supported forms: an exact
 * file path, `dir/**` (every file beneath), and `*` single-segment wildcards.
 * An entry is either a bare pattern string or a shared-surface object
 * `{ pattern, allow, reason }` — see SHARED-SURFACE ENTRIES above.
 */
export const MANIFEST = [
  "components/brand/**",
  "lib/brand-filter.ts",
  // Gate 5: the lead page's change-brand control — fully data-driven (names
  // and colours arrive as brands-table rows via props).
  "app/(dashboard)/leads/[id]/brand-changer.tsx",
  // Gate 11: the diary surfaces. Event styling is brand-resolved (styleFor()
  // over the slim brands prop; the brand picker and chips are data-driven),
  // but each keeps deliberate mm-red APP CHROME per PRD §2, plus comments
  // naming brands to document the parity contract — hence the allows.
  // Domains, phone numbers, Connor and mailboxes stay forbidden here, as
  // does every literal not named in `allow`.
  {
    pattern: "components/schedule/scheduler-view.tsx",
    allow: ["mm-red", "Marley", "Pitmans"],
    reason:
      "mm-red toolbar/today-ring/now-indicator/FAB app chrome (PRD §2); Marley + Pitmans appear only in comments documenting the parity contract and the accent-colour data rule",
  },
  {
    pattern: "components/schedule/schedule-allocation-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red tab/board/day-strip app chrome (PRD §2). (The soft-demand copy's hardcoded 'Marley' was the §10 leak this gate fixed — now brand-neutral, so no 'Marley' allow.)",
  },
  {
    pattern: "components/schedule/appointment-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): icon tints, required-field marker, radio accent, destructive-action button",
  },
  // Gate 11 residual: the client-record "Book survey" flows. Their brand
  // picker is data-driven (slim brands-table rows via props); only deliberate
  // mm-red APP CHROME remains per PRD §2 — everything else stays forbidden
  // both directions.
  {
    pattern: "components/clients/book-survey-button.tsx",
    allow: ["mm-red"],
    reason: "mm-red app chrome (PRD §2): the Book survey button fill and the required-field marker",
  },
  {
    pattern: "components/clients/add-client-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): checkbox accent, required-field markers, address section tint",
  },
  // Gate 12: resources + storage. The vehicle livery chip and Livery select,
  // the job-board livery-mismatch note, storage site/let chips, the brand
  // filter and the site/let/manage dialogs' brand selects are all data-driven
  // (slim brands-table rows via props); only deliberate mm-red APP CHROME
  // remains per PRD §2 — everything else stays forbidden both directions.
  {
    pattern: "components/resources/resources-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): active-toggle fill, working-days selected state, dialog save buttons",
  },
  {
    pattern: "components/job-board/job-board-view.tsx",
    allow: ["mm-red", "Marley"],
    reason:
      "mm-red app chrome (PRD §2): today-column highlight, surveys toggle, assign-modal selection states, save buttons and the vehicle icon-tile tint; Marley appears only in the comment naming that tile tint — the livery-mismatch note itself is data-driven",
  },
  {
    pattern: "components/storage/storage-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): occupancy pill and segmented occupancy filter, selected-site/unit accents, checkbox accents, action/save buttons",
  },
  {
    pattern: "components/storage/manage-let-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): sign-here checkbox accent and the sign/save/add action buttons",
  },
  // The storage-agreement sender. Excluded through gate 12 on the stated
  // grounds that branding its email "is gate 13 comms work" — but gate 13
  // landed and did exactly that conversion (the send resolves the LET's brand
  // and goes out from that brand's own front door), so the exclusion's trigger
  // had passed while the entry was never added. Under scan since 2026-09-02;
  // what remains is the default-brand arm of the same isDefault ternaries the
  // doc-defs allow, plus the app's own origin.
  {
    pattern: "app/(dashboard)/storage/actions.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity): the From and the name/phone selected by `signIsDefault`, plus the phone fallback for a row with no phone; ops.marleymoves.co.uk is the app's own origin for the agreement link (app chrome per PRD §2, as lib/job-sheet-load.ts)",
  },
  // The storage billing run. Its customer-visible note used to be four
  // module-level strings carrying one office number and one card offer,
  // resolved where no brand exists to resolve them against — so every storage
  // customer read the same number whoever was billing them. The note is now
  // built per invoice from the LET's brand (`storageInvoiceNote`), and the
  // emailed half takes the same brand and the same card verdict, so the two
  // halves of one invoice cannot disagree. Nothing brand-specific is left in
  // the file, comments included, so it goes under scan with no allow list.
  "lib/storage/raise-storage-invoices.ts",
  // Gate 19: the ingest stack. These three are brand-resolved by contract —
  // one route serves EVERY brand's website, the pure half derives the brand
  // from whichever secret matched (never the payload, PRD §3.8), and the
  // landing path takes brand as data — so they live under scan. The default
  // brand's name (and, in ingest.ts, its domain) appears only in comments
  // pinning the pre-brand-layer compatibility contract: the live site posts
  // with the original `LEAD_INGEST_SECRET` and must see zero change.
  //
  // Deliberately NOT listed, because they are PER-BRAND RAILS by design, not
  // leak surfaces (each rail is one brand's own delivery channel and may name
  // its brand, exactly as lib/sync/sanity-leads.ts — the default brand's pull
  // rail — has never been listed): lib/sync/wp-leads.ts and
  // app/api/cron/wp-leads/route.ts (the second brand's pull rail), and the
  // WordPress plugin under wordpress/pitmans-lead-bridge/ (PHP shipped to that
  // brand's own site; a "leak" of its brand into it is the point).
  {
    pattern: "lib/leads/ingest.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "comments only: the compatibility contract for the pre-brand-layer LEAD_INGEST_SECRET names whose secret it is and which live site posts with it",
  },
  {
    pattern: "app/api/ingest/lead/route.ts",
    allow: ["Marley"],
    reason:
      "comment only: the route contract doc names whose secret LEAD_INGEST_SECRET is and stays",
  },
  {
    pattern: "lib/leads/website-lead.ts",
    allow: ["Marley"],
    reason:
      "comments only: the brand-field doc and the sanity_id-stays-global rationale name which brand's pull rail carries a Sanity id",
  },
  // Gate 14: the JOB-document doc-defs (PRD §3.6). Brand identity, colours and
  // filenames arrive as a DocBrand from the brands row; the remaining default-
  // brand literals are the DEFAULT CONSTANTS selected when no brand is passed —
  // the byte-parity contract, so they are allowed, not leaks. (The GROUP
  // doc-defs — lib/crew-sheet/daily-docdef.ts, lib/staff/statement-docdef.ts —
  // are deliberately NOT listed: they carry group/default identity by design
  // and take no brand parameter.)
  {
    pattern: "lib/contract-docdef.ts",
    allow: ["Marley"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): the wordmark fallback and the in-person device line's default",
  },
  {
    pattern: "lib/completion-cert-docdef.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): wordmark, declaration and footer identity fallbacks",
  },
  {
    pattern: "lib/job-sheet-docdef.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): wordmark and footer fallbacks; 'Marley Ops' in the video-QR copy is the app name — app chrome per PRD §2",
  },
  {
    pattern: "lib/quote/pdf-client.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070", "Pitmans"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): the MarleyMoves filename shape, contact rows, footer legal line, pdf info block and the shared bank card (PRD §2 — one account for every brand); Marley elsewhere + Pitmans appear only in comments documenting the §10 filename shape and the WCAG accent pick",
  },
  {
    pattern: "lib/pdf/doc-brand.ts",
    allow: ["Marley"],
    reason:
      "appears only in a comment documenting the tint data rule the default-brand doc-defs hardcode — the module itself carries no identity, colour fallback #C03838 is the documented brandCtaColour degrade",
  },
  // Gate 14 call sites and PDF-triggering components: brand resolution happens
  // where a supabase client exists (getBrandOrDefault → docBrandFrom), then
  // travels as a plain DocBrand. The quote/crew UI keeps deliberate mm-red APP
  // CHROME (PRD §2 — the frame, not the records); remaining name hits are
  // jsdoc/comments documenting the byte-parity contract. Files with no
  // forbidden literal at all ride as bare entries so a later edit can never
  // quietly re-hardcode identity into a branded surface.
  "app/api/documents/contract/[signatureId]/route.ts",
  "components/job-sheet-button.tsx",
  "lib/crew-sheet/daily-data.ts",
  {
    pattern: "app/(dashboard)/quotes/[id]/page.tsx",
    allow: ["Marley"],
    reason:
      "appears only in the comment documenting that getBrandOrDefault's bad-slug fallback lands on the default-brand parity rail",
  },
  {
    pattern: "components/quote/quote-builder.tsx",
    allow: ["Marley", "mm-red"],
    reason:
      "mm-red app chrome (PRD §2): CTA buttons and wizard step dots; Marley appears only in the header comment and the brand-prop jsdoc documenting the parity contract",
  },
  {
    pattern: "components/quote/quote-header-actions.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): the send button. The gate-14 'Marley' allow is GONE — gate 13 rewrote the brand-prop jsdoc to describe the full brands row, so the literal no longer occurs and the dead-allow rule required its removal",
  },
  {
    pattern: "components/quote/resend-quote-button.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): the mail icon tint. The gate-14 'Marley' allow is GONE for the same reason as quote-header-actions.tsx above",
  },
  {
    pattern: "app/my-jobs/[id]/page.tsx",
    allow: ["mm-red"],
    reason: "mm-red app chrome (PRD §2): the removal type chip and the sticky action button",
  },
  {
    pattern: "components/crew/complete-job-button.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): trigger/submit buttons and the confirmation checkbox accent",
  },
  {
    pattern: "lib/job-sheet-load.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "ops.marleymoves.co.uk is the APP's own origin (NEXT_PUBLIC_APP_URL fallback for the crew job link — one app hosts every brand, app chrome per PRD §2, not document identity); Marley appears only in the legacy-iMVE contract comment",
  },
  // Gate 21: the /performance reporting surface. The report libs slice by a
  // brand PARAMETER (rows carry the slug as data, never a literal); the page's
  // segmented filter, tab links, chips and Brand column are all data-driven
  // from brands-table rows.
  "lib/sales-report.ts",
  "lib/storage-report.ts",
  "lib/estimator.ts",
  "components/performance/sales-tab.tsx",
  {
    pattern: "components/performance/storage-tab.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red occupancy-bar fill (PRD §4 /storage: occupancy is a physical fact, not a brand one — app chrome per §2)",
  },
  {
    pattern: "app/(dashboard)/performance/page.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red lost-reasons meter fill — report chart chrome (PRD §2), not a brand record",
  },
  // Gate 21 continued: the dashboard home. The KPI brand sub-lines, splits
  // and the section filter are all data-driven (buildBrandKpiSplits over
  // brands-table slugs; BrandChip/BrandFilter take slim brands rows via
  // props); only deliberate mm-red APP CHROME and one legacy-business-rule
  // comment remain — everything else stays forbidden both directions.
  "lib/dashboard/compute.ts",
  {
    pattern: "components/dashboard/dashboard-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): view-all/deep-dive links, KPI accent tiles, decline arrow and drop-percentage tints, stat accents",
  },
  {
    pattern: "app/(dashboard)/page.tsx",
    allow: ["Marley"],
    reason:
      "appears only in the legacy-iMVE contract-suppression comment (same rule lib/job-sheet-load.ts documents) — the unsigned-contracts tile logic, not rendered identity",
  },
  // Gate 13 residual (2026-09-02): the comms tree. PRD §10 names lib/comms/
  // FIRST among the paths the source grep covers and §3.5 makes it the
  // highest-risk surface in the project — a leak there arrives in a customer's
  // inbox under another brand's sign-off. The manifest nevertheless expanded to
  // ZERO files beneath it until now, so every run printed an OK line having
  // never opened one of them. The scan's header rule ("a file not listed is NOT
  // clean — it is UNSCANNED") was true the whole time and invisible: nothing
  // told the reader which side of it the comms tree fell on.
  //
  // The builders below take an optional `brand` and render the default brand's
  // exact bytes when it is absent (PRD §3.5), so their remaining literals are
  // the DEFAULT CONSTANTS of that parity contract plus the two cross-brand
  // disclosures §3.5 mandates — the same shape the gate-14 doc-defs allow.
  // Files with no forbidden literal at all ride as bare entries, per the
  // gate-14 practice above, so a later edit can never quietly hardcode identity
  // into one. tests/scripts/brand-leak-scan-comms.test.ts holds the coverage to
  // this: every file under lib/comms/ must be either listed here or named in
  // the exclusion note below, so a new comms module forces a decision rather
  // than defaulting to unscanned.
  "lib/comms/alt-recipient.ts",
  "lib/comms/bounce.ts",
  "lib/comms/brand-theme.ts",
  "lib/comms/commitment-chase-email.ts",
  "lib/comms/completion-email.ts",
  "lib/comms/escape-html.ts",
  "lib/comms/hash.ts",
  "lib/comms/invalid-email.ts",
  "lib/comms/permanent-failure.ts",
  "lib/comms/refund-emails.ts",
  "lib/comms/review-suppression.ts",
  "lib/comms/send-window.ts",
  "lib/comms/suppressions.ts",
  "lib/comms/survey-send-report.ts",
  {
    pattern: "lib/comms/templates.ts",
    allow: ["Marley", "Pitmans", "01747 637070"],
    reason:
      "the DEFAULT-BRAND fallback this whole scan exists to protect: brandName defaults to the default brand and the office number is returned ONLY for it, a non-default context degrading to reply-first contact instead; both brand names appear in the comment stating that rule",
  },
  {
    pattern: "lib/comms/quote-email.ts",
    allow: ["Marley"],
    reason:
      "comments only: the byte-lock notes recording that the default brand's arm is unchanged and why the live residential template must not be touched (PRD §11.7 trap 4)",
  },
  {
    pattern: "lib/comms/payment-email.ts",
    allow: ["Marley", "Connor"],
    reason:
      "default-brand constants + the §3.5 disclosures: the crew sign-off's `isDefault` arm names the default brand's owner, and the comments record the MarleyMoves Ltd bank disclosure and the crew-may-attend disclosure the other brands carry",
  },
  {
    pattern: "lib/comms/date-confirm-email.ts",
    allow: ["Marley"],
    reason: "comments only: the two §3.5 disclosures a non-default brand adds to this pre-move copy",
  },
  {
    pattern: "lib/comms/cancellation-emails.ts",
    allow: ["Marley"],
    reason:
      "the marley-cancel builder's LEGACY SYMBOL NAMES (MarleyCancelMeta, buildMarleyCancelEmailHtml — the we-cancelled template's id since before the brand layer; the copy they render names no brand), plus the crew-may-attend disclosure comments",
  },
  {
    pattern: "lib/comms/storage-invoice-email.ts",
    allow: ["Marley", "Connor"],
    reason:
      "comments only: the note on who would want dashboard-editable copy, and the §3.5 bank disclosure the non-default bank block carries",
  },
  {
    pattern: "lib/comms/review-request.ts",
    allow: ["Marley", "Pitmans", "Connor"],
    reason:
      "default-brand constant + contract docs: the crew sign-off's `isDefault` arm, and the comments pinning the never-borrow-the-default-brand's-listing rule, the own-front-door From rule and the §11.7 trap-4 template-id rule",
  },
  {
    pattern: "lib/comms/template-id.ts",
    allow: ["Marley"],
    reason:
      "comments only: the key convention doc explaining that brands.resend_template_ids is keyed by the default brand's env-var names and that its live wiring changes by nothing",
  },
  {
    pattern: "lib/comms/extract-reply.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "comments only: the worked example of a quoted-original header this parser has to survive (MMR015) — the parser itself matches on shape, never on a brand",
  },
  {
    pattern: "lib/comms/retry-worker.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "an INTERNAL ops alert, not customer copy: the SMTP-fallback mailbox it tells staff to check, and ops.marleymoves.co.uk as the app's own origin behind the lead link labelled with the app name (app chrome per PRD §2)",
  },
  // STILL-NOT-manifest, and this note is deliberately NOT self-clearing.
  //
  // The first two were written before gate 13 as "add both entries in gate 13's
  // PR instead". Gate 13 has now landed and they are still absent, because the
  // reason they were excluded has NOT gone away: both files retain default-
  // brand identity that an allow list would have to exempt wholesale, which is
  // exactly the masking the original note warned against.
  //
  //   components/quote/send-quote-dialog.tsx — the subject line's default arm
  //     is the "Marley Moves" literal (brand.slug !== "marley" ? brand.name :
  //     "Marley Moves"), plus the "MarleyMoves-Quote-<ref>.pdf" filename echo.
  //     Exempting those needs allow: ["Marley Moves", "MarleyMoves", ...],
  //     which would also wave through a genuine leak of either literal.
  //   app/actions/crew-signatures.ts — two marleymoves.co.uk office-notification
  //     links survive brand resolution.
  //
  // The rest of lib/comms/ is excluded for a DIFFERENT reason: these files ARE
  // the default identity, or one brand's own rail, so their literals are the
  // content rather than a leak — and an allow list broad enough to cover them
  // would suppress the whole file. Naming each here is what keeps the tree's
  // coverage legible, since the seventeen entries above cannot be read as
  // covering the folder.
  //
  //   lib/comms/email-brand.ts and lib/comms/branded-shell.ts — the DEFAULT
  //     THEME and the shared shell. The parity contract is that the default
  //     chrome IS today's literal strings, never values read back from the
  //     brands table, so every one of them lives here by design (the shared
  //     bank account and its §3.5 disclosure included).
  //   lib/comms/sender.ts, lib/comms/send.ts and lib/comms/dispatch.ts — the
  //     transport rails. The house From/reply/ops-alert addresses and the
  //     reply-domain recognition set are the default brand's own mailboxes,
  //     which a second brand's front door sits ALONGSIDE rather than replacing;
  //     narrowing them would stop the default brand recognising its own replies.
  //   lib/comms/survey-email.ts — an internal STAFF surface that stays on the
  //     default identity deliberately (its own header says so); it is not a
  //     customer-facing brand-resolved builder.
  //   lib/comms/review-platform.ts — per-brand rail: the default brand's own
  //     listing URLs. A non-default brand may only use ITS OWN listing, never
  //     borrow this one, which is the rule review-request.ts enforces.
  //
  // Added 2026-09-02, when lib/signatures.ts and components/cubic/cubic-builder
  // .tsx went under scan (see the shared-module block at the end of MANIFEST).
  // Sweeping the import graph of the five public token routes for anything else
  // rendering customer copy turned up these, and each is excluded on its own
  // grounds rather than by silence:
  //
  //   lib/brand.ts and lib/brand-page-theme.ts — the RESOLVERS. MARLEY_THEME is
  //     the default brand's identity written out verbatim, on purpose (PRD §1:
  //     the default render must not be able to move when a brands row changes),
  //     and the file also names the second brand in the comments explaining the
  //     colour and named-person rules. Exactly the grounds lib/comms/email-brand
  //     .ts sits here on. An allow list covering them would suppress the file.
  //   lib/legal/generated.ts — GENERATED from legal/, and the published bodies
  //     are immutable by design (hashes checked by scripts/build-legal.mjs
  //     --check in the gates). Its acknowledgment labels still name the default
  //     brand for every brand, which is why `signatures` keeps TWO columns: the
  //     RENDERED wording in ack_labels, and the published document's own in
  //     acknowledgment_labels. Gate 15 supersedes the document; nothing else can.
  //   components/quote/survey-photos.tsx — reachable from /cv only through an
  //     import, never through a render: cubic-builder gates it behind
  //     `office && leadId`. Its mm-red is office chrome (PRD §2). If a customer
  //     mode ever renders it, it joins the block above in the same change.
  //   components/crew/collect-contract-button.tsx — the IN-PERSON contract flow.
  //     It carries no literal of its own (only mm-red), so a bare entry would
  //     pass today and prove nothing: the defect is that it takes no brand at
  //     all and links TERMS_URL, the default brand's terms, for every brand's
  //     customer. Listing it would read as coverage of a surface that is
  //     genuinely wrong. It belongs here until it takes a brand.
  //
  // THE REST OF THE TOKEN ROUTES' IMPORT GRAPH (2026-09-02, second pass).
  //
  // The block above added the rule "a module that renders CUSTOMER-FACING COPY
  // on a brand-resolved surface belongs here, wherever it lives" and named four
  // files. It was written from a hand sweep, and a hand sweep is exactly the
  // instrument that cannot support the word "one by one": walking the import
  // graph of app/{q,s,cv,sheet,join}/[token] MECHANICALLY reaches 123 modules,
  // and TWENTY of them carry a forbidden literal while appearing neither in
  // MANIFEST nor anywhere in this note. One of them —
  // lib/payments/card-payments.ts — turned out to be customer email on a
  // brand-resolved surface, i.e. precisely what the new rule says belongs under
  // scan, and it is now listed above. The other nineteen are below, each with
  // its own grounds, because silence about them is the same defect the rule was
  // written to end.
  //
  // tests/scripts/brand-leak-scan-routes.test.ts now does that walk on every
  // run, so this list cannot rot: a new import that reaches a literal-carrying
  // module fails the suite until someone lists it or names it here.
  //
  // (a) CUSTOMER COPY, excluded because an allow list would suppress the file:
  //
  //   lib/quote/chase.ts — the chase and acceptance emails. It IS brand-resolved
  //     (`emailTheme(brand)`; every sign-off, pay line and signature block picks
  //     an arm off `t.isDefault`, and the non-default arm builds from the brands
  //     row), and the §3.5 group disclosure it renders for a non-default brand
  //     is mandated copy. But TEAM_SIGNATURE_HTML is the default brand's own
  //     signature written out verbatim — name, phone, mailbox, website, address,
  //     socials, logo — which is the same thing lib/comms/email-brand.ts is and
  //     sits here on. Listing it needs an allow of essentially every default
  //     literal, which would suppress the file rather than police it. What
  //     protects the non-default arms instead is
  //     tests/lib/comms/reply-display-name.test.ts (it pins every
  //     `replyAddressFor` call site to `brand.name`, so the function's
  //     default-brand default parameter cannot reach a second brand's customer)
  //     and the RENDERED half, which reads what a page actually served.
  //
  // (b) INTERNAL surfaces — staff read these, never a customer, so a default
  //     literal in them is addressed to the right audience:
  //
  //   lib/ops/issues.ts — the daily operational-issues email to the office, and
  //     the app's own origin behind its link (app chrome per PRD §2, as
  //     lib/comms/retry-worker.ts).
  //   lib/ops/zoho-access.ts — the ops alert telling an admin which ledger org
  //     to go and fix. Naming that org IS the remedy; a brand-neutral version
  //     would send them hunting.
  //   lib/refunds/queue-view.ts — the office refunds queue's TRIGGER_LABELS,
  //     keyed by the stored `marley_cancel` trigger enum that predates the brand
  //     layer. Office-facing, never rendered to a customer. (Its label is
  //     nonetheless wrong for a second-brand booking — recorded as a finding,
  //     not fixed by adding it here.)
  //
  // (c) NOT CUSTOMER-COPY SURFACES AT ALL — money computation, ledger clients,
  //     catalogues, settings, push payloads. Every hit in each is in a COMMENT
  //     (a business-rule note, an account name, a dated decision), so the rule's
  //     antecedent is not met and a bare entry could not pass anyway: buying an
  //     allow to exempt a comment would exempt the same literal in that file's
  //     code, which is the masking this note exists to refuse.
  //
  //   lib/cubic-catalogue.ts, lib/finance/invoices.ts, lib/ledger/xero-config.ts,
  //   lib/ledger/xero-contacts.ts, lib/ledger/xero-guard.ts, lib/legacy.ts,
  //   lib/payments-policy.ts, lib/payments/invoice-resend.ts, lib/posthog.ts,
  //   lib/push/categories.ts, lib/push/payload.ts, lib/quote/constants.ts,
  //   lib/quote/pricing.ts, lib/settings.ts, lib/zoho.ts
  //
  // So these remain unscanned, and that gap is stated here rather than being
  // hidden behind a green run (this file's own evidence-discipline rule: "I
  // could not check" must never render as "nothing to report"). Whoever
  // de-brands one of those surfaces adds its entry in the SAME change and
  // deletes its line here — do not add them earlier to make the manifest look
  // complete.

  // Gate 16: the customer accept page. Identity now comes entirely from
  // `pageTheme` — logo, name, phone, terms link, legal line, the accent (one
  // CSS-variable override on the shell, so the mm-red utility CLASSES below
  // are re-pointed rather than replaced) and whether card is mentioned at all.
  //
  // The mm-red allow is therefore not chrome in the §2 sense: these are record
  // surfaces whose token is re-pointed per brand at runtime, which a source
  // grep cannot see. That is exactly the gap the RENDERED half of this scan
  // exists to close, and it is why the class names stay — replacing them with
  // inline styles would lose every `hover:`/`focus:` accent variant.
  //
  // Domains, phone numbers, mailboxes and Connor stay forbidden here, and the
  // route folder carries none of them any more.
  //
  // These five patterns are `**`, NOT `*.tsx`, and that is load-bearing. They
  // were `*.tsx` until 2026-09-01, which made the scan certify a route folder
  // while never reading its server actions: `app/s/[token]/actions.ts` and
  // `app/cv/[token]/actions.ts` each returned a customer-facing error string
  // carrying 01747 637070 — a FORBIDDEN literal, on a surface the run called
  // clean. The header rule of this file is "a file not listed is NOT clean, it
  // is UNSCANNED", but a folder-shaped pattern reads as covering the folder, so
  // the reader had no way to see the gap. Scan the whole route folder and the
  // question cannot arise again.
  {
    pattern: "app/q/[token]/**",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the shell (gate 16); no hardcoded name, phone, domain or named individual remains",
  },
  // The accept-flow money spine behind /q (2026-09-02). Fifteen customer-
  // facing ERROR returns hardcoded the default brand's office number and
  // rendered verbatim on /q via `setError(res.error)` — the happy paths were
  // branded in gate 16 and the error paths were not. Every one now resolves
  // the quote's own brand (`errorPhone`), and this entry is what keeps it so.
  {
    pattern: "lib/quote/accept-flow.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070", "Connor"],
    reason:
      "default-brand constants + contract docs: the 01747 fallback inside the shared brand-phone pattern (errorPhone + invoicePayClause — reached only when a brands row carries no phone) and the comment byte-locking it; the §3.5 MarleyMoves Ltd disclosure in invoicePayClause; ops.marleymoves.co.uk as the app's own origin fallback (app chrome per PRD §2, as lib/job-sheet-load.ts); Marley/Connor elsewhere appear only in comments documenting orphan adoption and BACS recording. (The invoice attachment filenames now resolve through invoicePdfFilename in lib/quote/pdf-client.ts — no MarleyMoves-Invoice literal remains here.)",
  },
  // The card rail behind /q's "Pay by card" button (2026-09-02, found by the
  // import-graph walk described in the STILL-NOT note below). Its refund and
  // void notes are customer email, resolved from the QUOTE's brand
  // (`brandForComms` → `isDefaultBrand`), so it is a brand-resolved surface by
  // the rule this manifest states: a module that renders customer-facing copy on
  // one belongs here, wherever it lives.
  {
    pattern: "lib/payments/card-payments.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity): the name and phone selected by `isDefaultBrand` in the refund/void note, and ops.marleymoves.co.uk as the app's own origin for the hosted-payment return URL (app chrome per PRD §2, as lib/job-sheet-load.ts). The phone literal is allowed ONLY on the isDefaultBrand arm: the second-brand arm used to read `brand.phone ?? \"01747 637070\"`, which put the default office's line in a refund email to a customer who had never dealt with them, and an allow entry here would have hidden exactly that. It is now `brand.phone?.trim() || null` and the offer-to-call sentence is dropped when a brand carries no number. Nothing here names the second brand or a named individual, and both stay forbidden",
  },
  // The settle-in-full bank block CommitmentChoice renders inside /q — the
  // same shared account as BankPanel, so the §3.5 disclosure arrives as data
  // (the `disclosure` prop) and no operating-company literal may live here.
  {
    pattern: "components/quote/commitment-choice.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the /q shell (gate 16): radio accent and the bank block's amount/reference emphasis",
  },
  // Gate 16, the remaining token routes. Same mechanism throughout: identity
  // from `pageTheme`, accent from one CSS-variable override on the page root.
  //
  // /s and /cv are RECORD surfaces — they take the brand of the let and the
  // lead respectively. /sheet and /join are GROUP surfaces (PRD §4): one
  // shared crew across every brand, so they take `GROUP_PAGE_THEME`, whose
  // accent is neutral charcoal rather than either brand's colour.
  {
    pattern: "app/s/[token]/**",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the page root (gate 16); the storage-agreement identity, terms link and phone are all theme-resolved",
  },
  {
    pattern: "app/cv/[token]/**",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the page root (gate 16); CubicBuilder is shared with the office builder, which renders outside this element and is unaffected",
  },
  {
    pattern: "app/sheet/[token]/**",
    allow: ["mm-red"],
    reason:
      "group surface (PRD §4): the mm-red utilities are re-pointed to neutral charcoal by GROUP_PAGE_THEME, so a mixed-brand crew day is coloured as neither brand",
  },
  {
    pattern: "app/join/[token]/**",
    allow: ["mm-red"],
    reason:
      "group surface (PRD §4): one shared crew, so the copy names no brand and the accent is neutralised by GROUP_PAGE_THEME",
  },
  // Gate 16 residual (2026-09-02): the SHARED modules those route folders
  // render through.
  //
  // The four `**` patterns above cover the route folders and nothing else, and
  // a folder-shaped pattern reads as covering everything the folder puts on
  // screen — which is not what it does. Two of the worst leaks in the project
  // sat one import away from a scanned folder and were therefore UNSCANNED
  // while the run printed OK: `lib/signatures.ts`, whose storage lien tick-box
  // named the DEFAULT brand as the company that may sell a second brand's
  // customer's belongings, and `components/cubic/cubic-builder.tsx`, which put
  // the default brand's name and office number on /cv's only call to action.
  // Neither is exotic; both are simply the copy the route delegates.
  //
  // So the rule this block adds: a module that renders CUSTOMER-FACING COPY on
  // a brand-resolved surface belongs here, wherever it happens to live. Being
  // imported by a listed folder is not coverage.
  {
    pattern: "lib/signatures.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "default-brand constants (byte-parity, PRD §1): DEFAULT_SIGNING_COMPANY — the fallback the ack builders use when a caller has no brand in hand, so an unbranded call still renders today's exact bytes — and TERMS_URL, the default brand's published terms (a brand-resolved surface reads PageTheme.termsUrl instead; gate 15 retires the fallback). The lien and date-confirmation clauses themselves now take the company as data",
  },
  {
    pattern: "components/cubic/cubic-builder.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the /cv page root (gate 16) — the same mechanism app/cv/[token]/** is allowed on, and this component is the thing that root wraps. Identity (the send button's company name and the confirmation card's phone) arrives as a CubicCustomerBrand prop from pageTheme; the office builder renders outside that root and is unaffected",
  },
  {
    pattern: "components/quote/date-confirm-card.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the /q shell (gate 16): the icon tint, the option rows' checked state, the radio accent, the field focus ring and the confirm button. Rendered only by app/q/[token]/page.tsx; its ack wording comes from lib/signatures.ts and carries no literal",
  },
  {
    pattern: "lib/legal/documents.ts",
    allow: ["marleymoves.co.uk"],
    reason:
      'GATE 15 PENDING: publicUrlFor() is brand-blind, so the terms link /q and /s put in front of EVERY brand\'s customer points at the default brand\'s documents (0104_brands.sql: "terms_url null renders Marley terms until gate 15 ships the unified brand-neutral document"). Listed rather than excluded so the allow is the retirement trigger — when gate 15 lands, the dead-allow rule fails this scan and names the line to delete. e2e/public/brand-leak-rendered.spec.ts carries the same exemption, mustOccur, on the rendered half',
  },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** One path segment against one pattern segment, `*` = any run of chars. */
function segmentMatches(patternSeg, pathSeg) {
  const parts = patternSeg.split("*");
  if (parts.length === 1) return patternSeg === pathSeg;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!pathSeg.startsWith(first) || !pathSeg.endsWith(last)) return false;
  let pos = first.length;
  for (const part of parts.slice(1, -1)) {
    const idx = pathSeg.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return pathSeg.length - last.length >= pos;
}

/**
 * Segment-wise glob match — `**` spans any number of segments, `*` stays
 * within one. Hand-rolled (no regex, no dependency) so pattern literals never
 * need escaping.
 */
function globMatches(patternSegs, pathSegs, pi = 0, si = 0) {
  while (pi < patternSegs.length) {
    const seg = patternSegs[pi];
    if (seg === "**") {
      if (pi === patternSegs.length - 1) return true;
      for (let skip = si; skip <= pathSegs.length; skip += 1) {
        if (globMatches(patternSegs, pathSegs, pi + 1, skip)) return true;
      }
      return false;
    }
    if (si >= pathSegs.length) return false;
    if (!segmentMatches(seg, pathSegs[si])) return false;
    pi += 1;
    si += 1;
  }
  return si === pathSegs.length;
}

/** Repo-relative path with forward slashes. */
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Expand MANIFEST-style patterns to concrete files.
 * Returns { files, errors, entries } — `files` is the deduplicated union,
 * `entries` keeps the per-entry breakdown ({ pattern, allow, files }) so
 * shared-surface allows can be checked against exactly the files they cover.
 * A pattern matching nothing is an error, never a silent skip (a renamed
 * directory must not quietly blind the scan); an allow literal that is not
 * in FORBIDDEN is an error too (a typo must not suppress nothing, silently).
 */
export function expandManifest(manifest = MANIFEST, root = ROOT) {
  const files = new Set();
  const errors = [];
  const entries = [];
  const knownLiterals = new Set(FORBIDDEN.map((f) => f.literal));
  for (const entry of manifest) {
    const pattern = typeof entry === "string" ? entry : entry.pattern;
    const allow = typeof entry === "string" ? [] : (entry.allow ?? []);
    for (const literal of allow) {
      if (!knownLiterals.has(literal)) {
        errors.push(
          `allow literal is not in FORBIDDEN (typo? exact case matters): "${literal}" under ${pattern}`,
        );
      }
    }
    const magicIndex = pattern.indexOf("*");
    let matched = [];
    if (magicIndex === -1) {
      const full = path.join(root, pattern);
      if (existsSync(full) && statSync(full).isFile()) matched = [pattern];
    } else {
      // Walk from the deepest static directory prefix, then glob-match.
      const staticPrefix = pattern.slice(0, magicIndex);
      const baseDir = path.join(root, staticPrefix.slice(0, staticPrefix.lastIndexOf("/") + 1));
      if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
        const patternSegs = pattern.split("/");
        matched = walk(baseDir, [])
          .map((f) => rel(root, f))
          .filter((f) => globMatches(patternSegs, f.split("/")));
      }
    }
    if (matched.length === 0) {
      errors.push(`manifest pattern matched no files: ${pattern}`);
    }
    for (const f of matched) files.add(f);
    entries.push({ pattern, allow, files: matched });
  }
  return { files: [...files].sort(), errors, entries };
}

/**
 * Scan every manifest-matched file. Returns { files, findings, errors };
 * clean means files.length > 0, findings empty AND errors empty. Findings
 * for a shared-surface entry's allowed literals are suppressed — but a dead
 * allow (a literal with zero suppressed hits under its own pattern) is an
 * ERROR, so the exemption disappears in the same change as the literal.
 */
export function scanRepo({ manifest = MANIFEST, root = ROOT } = {}) {
  const { files, errors, entries } = expandManifest(manifest, root);
  if (files.length === 0) {
    errors.push(
      "brand-leak scan matched no files at all — a scan that scanned nothing must fail, not pass",
    );
  }
  const allowByFile = new Map();
  for (const { allow, files: entryFiles } of entries) {
    for (const f of entryFiles) {
      if (allow.length === 0) continue;
      const set = allowByFile.get(f) ?? new Set();
      for (const literal of allow) set.add(literal);
      allowByFile.set(f, set);
    }
  }
  const findings = [];
  const rawByFile = new Map();
  for (const file of files) {
    const content = readFileSync(path.join(root, file), "utf8");
    const raw = findLeaksInContent(content, file);
    rawByFile.set(file, raw);
    const allowed = allowByFile.get(file);
    findings.push(...(allowed ? raw.filter((f) => !allowed.has(f.literal)) : raw));
  }
  for (const { pattern, allow, files: entryFiles } of entries) {
    for (const literal of allow) {
      const occurs = entryFiles.some((f) =>
        (rawByFile.get(f) ?? []).some((hit) => hit.literal === literal),
      );
      if (!occurs) {
        errors.push(
          `dead allow: "${literal}" never occurs under ${pattern} — the exemption has outlived its justification, remove it`,
        );
      }
    }
  }
  return { files, findings, errors };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { files, findings, errors } = scanRepo();
  for (const error of errors) {
    console.error(`brand-leak-scan ERROR: ${error}`);
  }
  for (const f of findings) {
    console.error(
      `brand-leak-scan LEAK: ${f.file}:${f.line} contains "${f.literal}" (brand: ${f.brand}) — brand-resolved files read identity from the brands table, never literals`,
    );
  }
  if (errors.length > 0 || findings.length > 0) {
    console.error(
      `brand-leak-scan: FAILED — ${findings.length} leak(s), ${errors.length} error(s) across ${files.length} file(s).`,
    );
    process.exit(1);
  }
  console.log(
    `brand-leak-scan: OK — ${files.length} file(s) scanned, ${FORBIDDEN.length} literals checked, 0 leaks. (Only the ${MANIFEST.length} MANIFEST entries are read; anything else is UNSCANNED, not clean. WHERE THE EXCLUSIONS ARE ACCOUNTED FOR, AND WHERE THEY ARE NOT: two trees have their absences named file by file in the STILL-NOT-manifest note above, and a test holds each to it - lib/comms/ (tests/scripts/brand-leak-scan-comms.test.ts) and the import graph of the five public token routes (tests/scripts/brand-leak-scan-routes.test.ts). Everywhere ELSE in the repo, a file's absence from the manifest is recorded nowhere at all and means only that nobody has looked. This line previously claimed the exclusions were named one by one, full stop; walking that import graph mechanically found twenty literal-carrying modules the note had never mentioned, one of which was customer email. SOURCE HALF ONLY: this reads source text and nothing else, so it says NOTHING about what the pages rendered - a literal reaching a customer through a brands-table value, a helper outside the manifest, or a re-pointed mm-red token is invisible here by construction. The rendered half of PRD 6.4 is e2e/public/brand-leak-rendered.spec.ts; this line is clean only alongside that spec's result.)`,
  );
}
