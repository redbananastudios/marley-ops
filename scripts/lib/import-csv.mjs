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
