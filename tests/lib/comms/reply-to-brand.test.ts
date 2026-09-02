import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailReplyToFor, sendEmail } from "@/lib/comms/send";
import { pitmans } from "./brand-fixture";

/**
 * The fallback Reply-To for a TOKENLESS email (no q-<token> relay) was
 * hardcoded hello@marleymoves.co.uk in both transports — so a Pitmans email
 * without a reply token invited the customer to reply to Marley's mailbox.
 * The fallback must resolve from the SENDING brand's own front door, exactly
 * the way smsSenderFor resolves the SMS sender id (trap 7): a non-default
 * brand answers for itself, and marley/group/absent keep today's literal.
 */

describe("emailReplyToFor — the tokenless fallback answers for the sending brand", () => {
  it("a non-default brand's fallback is its own hello_from front door", () => {
    expect(emailReplyToFor({ slug: "pitmans", helloFrom: "info@pitmansremovals.co.uk" })).toBe(
      "info@pitmansremovals.co.uk",
    );
    expect(emailReplyToFor(pitmans)).toBe("info@pitmansremovals.co.uk");
  });

  it("marley, group, and absent all resolve to today's literal", () => {
    expect(emailReplyToFor()).toBe("hello@marleymoves.co.uk");
    expect(emailReplyToFor(null)).toBe("hello@marleymoves.co.uk");
    expect(emailReplyToFor({ slug: "marley", helloFrom: "never@used.example" })).toBe(
      "hello@marleymoves.co.uk",
    );
    // Group comms keep the operating company's identity end to end (PRD §11.10).
    expect(emailReplyToFor({ slug: "group", helloFrom: null })).toBe("hello@marleymoves.co.uk");
  });

  it("a stub or unusable hello_from degrades to the monitored Marley front door", () => {
    expect(emailReplyToFor({ slug: "pitmans", helloFrom: null })).toBe("hello@marleymoves.co.uk");
    expect(emailReplyToFor({ slug: "pitmans", helloFrom: "   " })).toBe("hello@marleymoves.co.uk");
    // Settings-editable value trying to smuggle header syntax never becomes a header.
    expect(emailReplyToFor({ slug: "pitmans", helloFrom: "Evil <attacker@evil.test>" })).toBe(
      "hello@marleymoves.co.uk",
    );
  });
});

describe("sendEmail — the Resend payload carries the brand-resolved fallback", () => {
  beforeEach(() => {
    process.env.MARLEY_RESEND_API_KEY = "test-resend-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const okFetch = () =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "email-1" }) });

  it("a tokenless Pitmans email invites replies to Pitmans, not Marley", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({
      to: "customer@example.com",
      subject: "Your quote",
      html: "<p>Hi</p>",
      idempotencyKey: "marley-comm/p1",
      brand: { slug: "pitmans", helloFrom: "info@pitmansremovals.co.uk" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_to).toBe("info@pitmansremovals.co.uk");
    // The brand snapshot steers the header only — it is never provider payload.
    expect(body).not.toHaveProperty("brand");
  });

  it("a brand-less send keeps today's exact fallback (marley byte-identical)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({
      to: "customer@example.com",
      subject: "Your quote",
      html: "<p>Hi</p>",
      idempotencyKey: "marley-comm/m1",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reply_to).toBe("hello@marleymoves.co.uk");
  });

  it("an explicit replyTo (the tokenized relay) always wins over the brand fallback", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({
      to: "customer@example.com",
      subject: "Your quote",
      html: "<p>Hi</p>",
      idempotencyKey: "marley-comm/p2",
      replyTo: "Pitmans Removals & Storage <q-tok@reply.marleymoves.co.uk>",
      brand: { slug: "pitmans", helloFrom: "info@pitmansremovals.co.uk" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reply_to).toBe(
      "Pitmans Removals & Storage <q-tok@reply.marleymoves.co.uk>",
    );
  });
});

describe("wiring — both transports and the dispatcher thread the brand", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("send.ts has no hardcoded Reply-To fallback left in either transport", () => {
    const src = read("lib/comms/send.ts");
    // Resend payload + IONOS SMTP fallback both resolve through the brand.
    expect(src).toContain('reply_to: input.replyTo || emailReplyToFor(input.brand)');
    expect(src).toContain("replyTo: input.replyTo || emailReplyToFor(input.brand)");
    expect(src).not.toContain('input.replyTo || "hello@marleymoves.co.uk"');
  });

  it("dispatchComm snapshots the reply-identity fields for a non-default brand", () => {
    const src = read("lib/comms/dispatch.ts");
    // Stored on the provider request so a comms-retry re-drive fronts the same
    // fallback Reply-To as the original send (trap 7's email sibling).
    expect(src).toContain("brand: { slug: input.brand.slug, helloFrom: input.brand.helloFrom }");
  });
});
