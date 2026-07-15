/**
 * Decoupled opener for the global command palette.
 *
 * The palette is mounted once in the office dashboard layout and listens for
 * this window event, so any client surface (e.g. the mobile header search
 * button) can open it without a shared React context.
 */

export const SEARCH_OPEN_EVENT = "mm:open-search";

/** Open the global command palette from anywhere on the client. */
export function openGlobalSearch() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SEARCH_OPEN_EVENT));
  }
}
