/**
 * Fleet-reminder digest email (pure — testable). One branded email lists every
 * vehicle document that crossed a reminder threshold today. Internal ops copy
 * for Peter / Connor / Luke — house style, no em-dashes, no customer framing.
 */

export interface DigestItem {
  vehicleName: string;
  expiryLabel: string; // "MOT", "Tax", "Insurance", "Service", "Lease end"
  dueDate: string; // YYYY-MM-DD
  days: number; // whole days until due (negative = overdue)
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function prettyDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "due in 7 days (16 Jul 2026)" / "due today (…)" / "overdue by 8 days (was …)". */
export function dueingPhrase(days: number, dueDate: string): string {
  const d = prettyDate(dueDate);
  if (days < 0) {
    const n = Math.abs(days);
    return `overdue by ${n} day${n === 1 ? "" : "s"} (was ${d})`;
  }
  if (days === 0) return `due today (${d})`;
  return `due in ${days} day${days === 1 ? "" : "s"} (${d})`;
}

export function fleetDigestSubject(items: DigestItem[]): string {
  if (items.length === 1) {
    const it = items[0];
    return `Fleet reminder: ${it.vehicleName} ${it.expiryLabel} ${dueingPhrase(it.days, it.dueDate)}`;
  }
  return `Fleet reminders: ${items.length} vehicle documents need attention`;
}

const RESOURCES_URL = "https://ops.marleymoves.co.uk/resources?tab=vehicles";

export function fleetDigestHtml(items: DigestItem[]): string {
  const rows = items
    .map((it) => {
      const overdue = it.days < 0;
      return `<tr><td style="padding:10px 12px;border-bottom:1px solid #EAE7E2;font-size:14px;color:#1F1D1B;"><strong>${esc(it.vehicleName)}</strong> ${esc(it.expiryLabel)} <span style="color:${overdue ? "#C03838" : "#6F6A64"};font-weight:${overdue ? "bold" : "normal"};">${esc(dueingPhrase(it.days, it.dueDate))}</span></td></tr>`;
    })
    .join("");
  const lead =
    items.length === 1
      ? "A vehicle document needs attention:"
      : `${items.length} vehicle documents need attention:`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F6F5F3;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #EAE7E2;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#2A2927;padding:18px 24px;">
        <span style="font-size:18px;font-weight:bold;color:#ffffff;">Marley <span style="color:#E85959;">Moves</span></span>
      </td></tr>
      <tr><td style="padding:24px;">
        <p style="margin:0 0 16px;font-size:16px;color:#1F1D1B;"><strong>Fleet reminders</strong></p>
        <p style="margin:0 0 16px;font-size:14px;color:#6F6A64;">${lead}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EAE7E2;border-radius:6px;">${rows}</table>
        <p style="margin:20px 0 0;">
          <a href="${RESOURCES_URL}" style="display:inline-block;background:#C03838;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 22px;border-radius:6px;">Open Staff &amp; Fleet</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#6F6A64;">Book the garage slot or renew the document, then update the date in Staff &amp; Fleet to clear the reminder.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
