import { describe, expect, it } from "vitest";

import { classifyBounce, suppressesAddress } from "@/lib/comms/bounce";

describe("classifyBounce", () => {
  it("treats a complaint as its own outcome, whatever the bounce field says", () => {
    expect(classifyBounce("email.complained")).toBe("complaint");
    expect(classifyBounce("email.complained", "Transient")).toBe("complaint");
  });

  it("recognises the transient markers as soft", () => {
    for (const t of ["Transient", "soft", "SOFT", "Temporary", "Deferred", "MailboxFull", "mailbox_full", "message-too-large"]) {
      expect(classifyBounce("email.bounced", t)).toBe("soft");
    }
  });

  it("defaults to hard — an unknown or missing classification must not be assumed transient", () => {
    // Getting this wrong the other way means we keep emailing a dead address and
    // the lead lapses to a false "lost — no response".
    for (const t of [undefined, null, "", "Permanent", "General", "Suppressed", "NoEmail", "something-new"]) {
      expect(classifyBounce("email.bounced", t)).toBe("hard");
    }
  });

  it("only hard bounces and complaints stop us trusting the address", () => {
    // A full mailbox clears itself; flagging it would pause chasing on a live job.
    expect(suppressesAddress("soft")).toBe(false);
    expect(suppressesAddress("hard")).toBe(true);
    expect(suppressesAddress("complaint")).toBe(true);
  });
});
