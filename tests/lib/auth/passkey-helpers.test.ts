import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_MS,
  MAX_FAILED_VERIFIES,
  challengeExpiry,
  decodeClientDataChallenge,
  deviceLabelFromUserAgent,
  isChallengeExpired,
  isRateLimited,
  rpConfigFromUrl,
} from "@/lib/auth/passkey-helpers";

describe("challenge expiry", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");

  it("expires exactly TTL after issue", () => {
    expect(challengeExpiry(now)).toBe(new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString());
  });

  it("respects a custom ttl", () => {
    expect(challengeExpiry(now, 1000)).toBe("2026-07-15T12:00:01.000Z");
  });

  it("is not expired one second before expiry", () => {
    const exp = challengeExpiry(now);
    expect(isChallengeExpired(exp, new Date(now.getTime() + CHALLENGE_TTL_MS - 1000))).toBe(false);
  });

  it("is expired at and after expiry", () => {
    const exp = challengeExpiry(now);
    expect(isChallengeExpired(exp, new Date(now.getTime() + CHALLENGE_TTL_MS))).toBe(true);
    expect(isChallengeExpired(exp, new Date(now.getTime() + CHALLENGE_TTL_MS + 1))).toBe(true);
  });

  it("treats an unparseable timestamp as expired (fail closed)", () => {
    expect(isChallengeExpired("not-a-date", now)).toBe(true);
  });
});

describe("rate limiting", () => {
  it("allows below the ceiling", () => {
    expect(isRateLimited(0)).toBe(false);
    expect(isRateLimited(MAX_FAILED_VERIFIES - 1)).toBe(false);
  });

  it("blocks at and above the ceiling", () => {
    expect(isRateLimited(MAX_FAILED_VERIFIES)).toBe(true);
    expect(isRateLimited(MAX_FAILED_VERIFIES + 5)).toBe(true);
  });
});

describe("device label", () => {
  it("names iPhones and iPads", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iPhone");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("iPad");
  });

  it("names Android phones vs tablets", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8 Mobile)")).toBe(
      "Android phone",
    );
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 14; Tab)")).toBe("Android tablet");
  });

  it("falls back to computer for desktop and unknown", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "This computer",
    );
    expect(deviceLabelFromUserAgent(null)).toBe("This device");
    expect(deviceLabelFromUserAgent("")).toBe("This device");
  });
});

describe("rp config", () => {
  it("derives host + origin from the app url", () => {
    expect(rpConfigFromUrl("https://ops.marleymoves.co.uk")).toEqual({
      rpID: "ops.marleymoves.co.uk",
      origin: "https://ops.marleymoves.co.uk",
      rpName: "Marley Ops",
    });
  });

  it("strips port from rpID but keeps it in origin (local dev)", () => {
    const cfg = rpConfigFromUrl("http://localhost:3000");
    expect(cfg.rpID).toBe("localhost");
    expect(cfg.origin).toBe("http://localhost:3000");
  });

  it("falls back to production on a bad url", () => {
    expect(rpConfigFromUrl("not a url").rpID).toBe("ops.marleymoves.co.uk");
    expect(rpConfigFromUrl(null).rpID).toBe("ops.marleymoves.co.uk");
  });
});

describe("clientData challenge decode", () => {
  it("extracts the base64url challenge from signed client data", () => {
    const challenge = "abc123_-";
    const clientData = { type: "webauthn.get", challenge, origin: "https://ops.marleymoves.co.uk" };
    const b64 = Buffer.from(JSON.stringify(clientData), "utf8").toString("base64url");
    expect(decodeClientDataChallenge(b64)).toBe(challenge);
  });

  it("returns null on garbage or missing challenge", () => {
    expect(decodeClientDataChallenge("!!!not-base64-json!!!")).toBeNull();
    const noChallenge = Buffer.from(JSON.stringify({ type: "webauthn.get" }), "utf8").toString(
      "base64url",
    );
    expect(decodeClientDataChallenge(noChallenge)).toBeNull();
  });
});
