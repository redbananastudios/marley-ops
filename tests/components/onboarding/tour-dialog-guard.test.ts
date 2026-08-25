import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCKING_DIALOG_SELECTOR,
  hasOpenBlockingDialog,
  type DialogGuardDocument,
} from "@/components/onboarding/dialog-guard";

/**
 * QA-20260825-02: the tour auto-started 1.2s after mount with no regard for a
 * dialog already open underneath it — its full-viewport overlay swallowed the
 * dialog's clicks, and driver.js's window-global Escape handler closed the
 * dialog together with the tour. The guard below defers auto-start while a
 * dialog is open; the wiring assertions pin the tour to actually using it and
 * to keeping driver.js's keyboard handling off.
 */

function fakeDialog({
  visible = true,
  inTourPopover = false,
}: { visible?: boolean; inTourPopover?: boolean } = {}): HTMLElement {
  return {
    closest: (selector: string) =>
      inTourPopover && selector === ".driver-popover" ? ({} as Element) : null,
    getClientRects: () => (visible ? [{}] : []),
  } as unknown as HTMLElement;
}

function fakeDocument(...nodes: HTMLElement[]): DialogGuardDocument {
  return {
    querySelectorAll: (selector: string) =>
      selector === BLOCKING_DIALOG_SELECTOR ? nodes : [],
  };
}

describe("hasOpenBlockingDialog", () => {
  it("matches both plain dialogs and alertdialogs", () => {
    expect(BLOCKING_DIALOG_SELECTOR).toContain('[role="dialog"]');
    expect(BLOCKING_DIALOG_SELECTOR).toContain('[role="alertdialog"]');
  });

  it("reports an open dialog", () => {
    expect(hasOpenBlockingDialog(fakeDocument(fakeDialog()))).toBe(true);
  });

  it("reports nothing when no dialog is mounted", () => {
    expect(hasOpenBlockingDialog(fakeDocument())).toBe(false);
  });

  it("ignores a hidden dialog shell (must not hold auto-start back forever)", () => {
    expect(hasOpenBlockingDialog(fakeDocument(fakeDialog({ visible: false })))).toBe(false);
  });

  it("ignores driver.js's own popover (also role=dialog)", () => {
    expect(hasOpenBlockingDialog(fakeDocument(fakeDialog({ inTourPopover: true })))).toBe(false);
  });

  it("still reports a real dialog alongside the tour popover", () => {
    expect(
      hasOpenBlockingDialog(fakeDocument(fakeDialog({ inTourPopover: true }), fakeDialog())),
    ).toBe(true);
  });
});

describe("tour.tsx wiring (QA-20260825-02)", () => {
  const source = readFileSync(
    join(__dirname, "../../../components/onboarding/tour.tsx"),
    "utf8",
  );

  it("disables driver.js's global keyboard handling so Escape can't also close a dialog", () => {
    expect(source).toMatch(/allowKeyboardControl:\s*false/);
  });

  it("consults the open-dialog guard before auto-starting", () => {
    expect(source).toMatch(/hasOpenBlockingDialog\(/);
  });
});
