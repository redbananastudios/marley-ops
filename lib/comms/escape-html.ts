/**
 * HTML-escape a user-controlled value before interpolating it into an email or
 * internal ops-alert body. Use for ANY customer-entered string (names, notes):
 * a lead controls these via the public /q, /s and /cv forms, and mail clients
 * render links/images even when they strip <script>. Consolidates the ad-hoc
 * esc() helpers scattered across lib/comms.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
