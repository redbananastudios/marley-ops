// Node's globals provide atob + crypto.randomUUID — no DOM needed here.
import { describe, expect, it } from "vitest";
import {
  derivePushUiState,
  detectInstallRequired,
  getOrCreateInstallationId,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from "@/lib/push/client";

const base: PushEnvironment = {
  supported: true,
  installRequired: false,
  systemEnabled: true,
  permission: "default",
  hasSubscription: false,
  serverRegistered: false,
};

describe("derivePushUiState (PRD §16.2 state machine)", () => {
  it("walks the precedence: install → unsupported → admin off → blocked", () => {
    expect(derivePushUiState({ ...base, supported: false })).toBe("unsupported");
    expect(derivePushUiState({ ...base, installRequired: true })).toBe("install_required");
    expect(derivePushUiState({ ...base, systemEnabled: false })).toBe("admin_disabled");
    expect(derivePushUiState({ ...base, permission: "denied" })).toBe("blocked");
  });

  it("iOS Safari TAB reality: push APIs hidden (unsupported) + not installed → still install_required", () => {
    // This is the ONLY combination a real iPhone Safari tab produces — the
    // answer must be install instructions, never "unsupported".
    expect(derivePushUiState({ ...base, supported: false, installRequired: true })).toBe(
      "install_required",
    );
  });

  it("available until granted + subscribed + server-registered = enabled", () => {
    expect(derivePushUiState(base)).toBe("available");
    expect(derivePushUiState({ ...base, permission: "granted" })).toBe("available");
    expect(
      derivePushUiState({ ...base, permission: "granted", hasSubscription: true, serverRegistered: true }),
    ).toBe("enabled");
  });

  it("granted + browser subscription but no server record = needs_repair", () => {
    expect(
      derivePushUiState({ ...base, permission: "granted", hasSubscription: true, serverRegistered: false }),
    ).toBe("needs_repair");
  });
});

describe("detectInstallRequired (iOS/iPadOS Home Screen rule)", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ipadDesktopMode =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

  it("iPhone Safari tab → install required; installed PWA → not", () => {
    expect(detectInstallRequired({ userAgent: iphone, standalone: false, maxTouchPoints: 5 })).toBe(true);
    expect(detectInstallRequired({ userAgent: iphone, standalone: true, maxTouchPoints: 5 })).toBe(false);
  });

  it("iPadOS masquerading as macOS is caught via touch points", () => {
    expect(detectInstallRequired({ userAgent: ipadDesktopMode, standalone: false, maxTouchPoints: 5 })).toBe(true);
  });

  it("real desktop macOS and Android are never install-gated", () => {
    expect(detectInstallRequired({ userAgent: ipadDesktopMode, standalone: false, maxTouchPoints: 0 })).toBe(false);
    expect(detectInstallRequired({ userAgent: android, standalone: false, maxTouchPoints: 5 })).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 (the VAPID public key format)", () => {
    // "hello" → aGVsbG8 (url-safe, unpadded)
    const arr = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(arr)).toEqual([104, 101, 108, 108, 111]);
  });

  it("handles url-safe replacement characters", () => {
    // 0xfb 0xef → "--8" in url-safe base64 ("+/8" standard)
    const arr = urlBase64ToUint8Array("--8");
    expect(Array.from(arr)).toEqual([251, 239]);
  });
});

describe("getOrCreateInstallationId", () => {
  it("mints a uuid once and returns the same one after", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const first = getOrCreateInstallationId(storage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getOrCreateInstallationId(storage)).toBe(first);
  });

  it("replaces a corrupted stored value", () => {
    const store = new Map<string, string>([["mm-push-installation-id", "junk!"]]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(getOrCreateInstallationId(storage)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
