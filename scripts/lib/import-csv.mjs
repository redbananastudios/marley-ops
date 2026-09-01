/**
 * Shared parsing + safety helpers for the gate-20 CSV importers.
 *
 * scripts/import-imve.mjs carries its own copies and is deliberately NOT
 * refactored onto this module: it ran the real 2026-08-13 production import,
 * its behaviour is proven, and re-pointing it at shared code to save
 * duplication would risk changing how a historical import replays for no
 * benefit. New importers share; the proven one is left alone.
 *
 * Everything here is pure and side-effect free except fetchAllRows, so the
 * validation that decides whether real customer money is imported correctly can
 * be unit-tested without a database (tests/scripts/import-csv.test.ts).
 */

/**
 * RFC4180-ish CSV parse: quoted fields, doubled quotes, CR/CRLF/LF, and a
 * stripped UTF-8 BOM (Excel writes one, and it would otherwise become part of
 * the first header name and silently orphan that column).
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** Header row -> a `col(row, "name")` reader. Names are lowercased, spaces to _. */
export function headerReader(headerRow) {
  const header = headerRow.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return {
    header,
    col: (row, name) => {
      const i = header.indexOf(name);
      return i >= 0 ? String(row[i] ?? "").trim() : "";
    },
  };
}

export const yes = (v) => /^(y|yes|true|1|paid)$/i.test(String(v ?? "").trim());

/**
 * Money as a number, or null when the cell is empty or cannot be read. Null is
 * the whole point: a caller must treat an unreadable non-empty cell as an ERROR
 * rather than defaulting to 0, or "1O0" imports as a £0 settled job.
 *
 * Empty returns null too, NOT 0 — `Number("")` is 0, which would quietly invent
 * an amount for a cell nobody filled in. Callers that have a real default say
 * so at the call site with `?? 0`; callers that don't (agreed_price) get a null
 * their validation already rejects.
 */
export const money = (v) => {
  const s = String(v ?? "").replace(/[£,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** ISO (YYYY-MM-DD) or UK (D/M/YYYY) -> YYYY-MM-DD, else null. */
export function isoDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * ISO instant for HH:00 UK-local on a date, correct across GMT/BST.
 *
 * Built by measuring what the naive guess actually renders as in Europe/London
 * and correcting by the difference, rather than assuming an offset — an
 * appointment written as 08:00 UTC would be 09:00 on the crew's diary for the
 * seven months of the year the UK is on BST.
 */
export function ukTime(dateStr, hour) {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const ukHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(guess),
  );
  return new Date(guess.getTime() - (ukHour - hour) * 3600_000).toISOString();
}

export const normEmail = (v) => String(v ?? "").trim().toLowerCase() || null;

/** Digits only, 44-prefix normalised to 0, for loose phone matching. */
export const phoneDigits = (v) => String(v ?? "").replace(/\D/g, "").replace(/^44/, "0");

/**
 * The ONE definition of "which customer is this row" — so an importer's dry-run
 * plan and its findClient lookup cannot drift apart about who is the same
 * person.
 *
 * Returns null, never a placeholder, when the row carries nothing that could
 * identify anybody. That null is the whole point. `phoneDigits("")` is the
 * empty STRING and `a ?? b` does not fall through on "", so a key written as
 * `email ?? phoneDigits(phone) ?? name` handed every contactless row the same
 * key "": the first printed NEW and every one after it printed MATCH. The
 * write path was never fooled (it re-resolves through findClient, which
 * correctly matches neither), but the printed plan is exactly what a human
 * approves before a live-money import, and it was telling them a sheet of
 * unrelated customers was one customer repeated.
 *
 * The `>= 10` threshold mirrors findClient: a six-digit phone can never match
 * a client there either, so it must not produce a MATCH in the plan.
 *
 * There is deliberately NO name fallback. findClient has no name matching, so
 * a name-keyed MATCH would advertise a dedupe the write path does not perform.
 * The plan's notion of identity must mirror findClient's, never extend it.
 *
 * The `e:`/`p:` prefixes keep the two namespaces apart, so an email that
 * happens to read as digits can never collide with a phone number.
 */
export function contactKey(email, phone) {
  const e = normEmail(email);
  if (e) return `e:${e}`;
  const digits = phoneDigits(phone);
  return digits.length >= 10 ? `p:${digits}` : null;
}

/**
 * Line-numbered errors for rows of ONE sheet that collide on `keyFn`.
 *
 * Every importer resolves each row against the state as it was BEFORE the
 * batch, so a duplicate inside a single CSV is invisible to it: both rows miss
 * the pre-batch lookup maps, both plan as NEW, and both get written. That is
 * how a fleet sheet listing one van under two callsigns becomes two vans, how a
 * crew list with a repeated person becomes two payroll records, and how a
 * storage sheet with a repeated CLOSED let re-raises a customer's entire
 * billing history — storage_lets_open_uq is `unique (unit_id) where end_date is
 * null`, so the database stops the open case and nothing stops the closed one.
 *
 * Catching it at validation, before a single row is read from the database, is
 * deliberate: it names BOTH clashing lines while the operator still has the
 * spreadsheet open, rather than failing part-way through a live import with a
 * constraint name and no clue which rows collided. A dry run cannot find these
 * either — it performs no inserts, so every duplicate row legitimately reports
 * "would create".
 *
 * A null or empty key means "this row has nothing that could collide" and is
 * SKIPPED, never bucketed with the other blanks. Treating missing data as a
 * shared key is how a dedupe check invents duplicates that do not exist.
 *
 * @param rows     objects carrying `.line` (the 1-based CSV line number)
 * @param keyFn    row -> key string, or null when the row cannot collide
 * @param describe row -> how to name that row in the message, in the sheet's
 *                 own words rather than in the normalised key
 * @param why      the consequence clause appended to every message
 */
export function duplicateKeyErrors(rows, keyFn, describe, why) {
  const firstLineByKey = new Map();
  const errors = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null || key === "") continue;
    const first = firstLineByKey.get(key);
    if (first === undefined) firstLineByKey.set(key, row.line);
    else errors.push(`line ${row.line}: ${describe(row)} is already on line ${first} — ${why}`);
  }
  return errors;
}

export function normMethod(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/bank|bacs|transfer/.test(s)) return "bank_transfer";
  if (/card/.test(s)) return "card";
  if (/cash/.test(s)) return "cash";
  return null;
}

/**
 * Which database the URL points at.
 *
 * "local" is recognised in its own right rather than lumped in with prod: if
 * writing to a dev database requires --prod, then the single flag guarding
 * production becomes something you type routinely, and a guard used every day
 * stops being read.
 */
export function targetKind(url) {
  const t = new URL(url);
  if (/\.supabase\.co$/i.test(t.hostname)) return "staging";
  if (t.port === "54321" || ["localhost", "127.0.0.1", "::1"].includes(t.hostname)) return "local";
  return "prod";
}

export const TARGET_LABEL = {
  staging: "staging/hosted",
  local: "LOCAL dev",
  prod: "SELF-HOSTED — prod?",
};

/**
 * Page through a PostgREST select. A plain select is capped at 1,000 rows
 * (PGRST_DB_MAX_ROWS), and an importer that silently read only the first page
 * would re-create clients it already had.
 */
export async function fetchAllRows(build, onError) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return onError(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
