import { describe, it, expect, afterEach } from "vitest";
import {
  hashInviteToken,
  inviteHashesMatch,
  mintCrewInvite,
  isInviteExpired,
  crewInviteUrl,
  CREW_INVITE_TTL_DAYS,
} from "@/lib/staff/crew-invite";

describe("crew invite tokens", () => {
  const origBase = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (origBase === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = origBase;
  });

  it("hashes deterministically to 64 hex chars", () => {
    const h = hashInviteToken("abc123");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken("abc123")).toBe(h);
    expect(hashInviteToken("abc124")).not.toBe(h);
  });

  it("mints a token whose stored hash matches, expiring ~7 days out", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const inv = mintCrewInvite(now);
    // Raw token is url-safe and never equals its stored hash.
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(inv.token).not.toBe(inv.tokenHash);
    expect(inv.tokenHash).toBe(hashInviteToken(inv.token));
    const expected = new Date(now.getTime() + CREW_INVITE_TTL_DAYS * 86_400_000).toISOString();
    expect(inv.expiresAt).toBe(expected);
    // Two mints never collide.
    expect(mintCrewInvite(now).token).not.toBe(inv.token);
  });

  it("treats missing/past expiry as expired, future as valid", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    expect(isInviteExpired(null, now)).toBe(true);
    expect(isInviteExpired(undefined, now)).toBe(true);
    expect(isInviteExpired("not-a-date", now)).toBe(true);
    expect(isInviteExpired(new Date(now.getTime() - 1000).toISOString(), now)).toBe(true);
    expect(isInviteExpired(new Date(now.getTime() + 1000).toISOString(), now)).toBe(false);
  });

  it("compares hashes in constant-ish time, safely", () => {
    const h = hashInviteToken("x");
    expect(inviteHashesMatch(h, h)).toBe(true);
    expect(inviteHashesMatch(h, hashInviteToken("y"))).toBe(false);
    expect(inviteHashesMatch(null, h)).toBe(false);
    expect(inviteHashesMatch(h, undefined)).toBe(false);
    expect(inviteHashesMatch("short", h)).toBe(false); // different length never throws
  });

  it("builds the set-password URL from the app base with the token encoded", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://ops.marleymoves.co.uk/";
    const url = crewInviteUrl("a b+c/d");
    expect(url).toBe("https://ops.marleymoves.co.uk/auth/set-password?token=a%20b%2Bc%2Fd");
    expect(url).not.toMatch(/\/\/auth/); // trailing slash on base was trimmed
  });

  it("falls back to the prod base when the env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(crewInviteUrl("tok")).toBe("https://ops.marleymoves.co.uk/auth/set-password?token=tok");
  });
});
