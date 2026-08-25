/**
 * QA-20260825-02: the tour's full-viewport overlay must never land on top of a
 * dialog the user is already working in — every click on the dialog's controls
 * is silently swallowed by driver.js's SVG overlay (reproduced on the
 * /schedule/surveys?leadId=… "Book survey" dialog, which opens on load and lost
 * the race against the 1.2s auto-start). Radix `Dialog`/`AlertDialog` render
 * `role="dialog"`/`role="alertdialog"` and unmount on close, so a visible match
 * means a dialog is open right now. driver.js's own popover is ALSO
 * `role="dialog"` — anything inside `.driver-popover` is ignored so a running
 * tour never counts itself as a blocker.
 */

export const BLOCKING_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/** Structural subset of Document so the guard is testable without a DOM. */
export type DialogGuardDocument = {
  querySelectorAll(selector: string): ArrayLike<HTMLElement>;
};

export function hasOpenBlockingDialog(doc: DialogGuardDocument): boolean {
  const nodes = doc.querySelectorAll(BLOCKING_DIALOG_SELECTOR);
  for (const node of Array.from(nodes)) {
    if (node.closest(".driver-popover")) continue;
    // Same visibility test as the tour's step resolution — a display:none
    // dialog shell must not hold the auto-start back forever.
    if (node.getClientRects().length > 0) return true;
  }
  return false;
}
