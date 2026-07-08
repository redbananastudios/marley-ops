/**
 * Phone display rule (Peter, 2026-07-08): the UI always shows UK national format
 * ("07572 382366" style digits, no +44). E.164 exists only internally — the clients
 * dedupe spine stores phone_e164, and senders convert at send time (see sendSms).
 */
export function ukPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = p.replace(/[\s()-]/g, "");
  if (/^\+44\d{10}$/.test(d)) return "0" + d.slice(3);
  if (/^44\d{10}$/.test(d)) return "0" + d.slice(2);
  return p;
}
