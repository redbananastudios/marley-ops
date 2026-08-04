import { describe, it, expect } from "vitest";
import { extractReplyText, htmlToText, splitReply } from "@/lib/comms/extract-reply";

describe("extractReplyText", () => {
  it("keeps only the new message from a Yahoo reply (the reported wall of text)", () => {
    const raw =
      "Quick question please Luke Do your guys connect the washing machine up. Thanks Mark " +
      "Yahoo Mail: Search, organise, conquer " +
      "On Sat, 1 Aug 2026 at 10:21, Luke at Marley Moves <luke@marleymoves.co.uk> wrote: " +
      "Marley Moves Your fixed price from Marley Moves: £1,856.40. PDF attached. | | | | Hi Marks, | | " +
      "Your fixed price. | | Total move cost £1,856.40 | | Accept your quote online →";
    expect(extractReplyText(raw)).toBe(
      "Quick question please Luke Do your guys connect the washing machine up. Thanks Mark",
    );
  });

  // --- over-cut guards (must NOT drop the customer's words) ---

  it("does not cut on a customer's 'on the road … wrote' inside a flattened reply", () => {
    const raw =
      "Yes please book it, and can your team park on the road out front? Thanks " +
      "On Sat, 1 Aug 2026 at 10:21, Luke at Marley Moves <luke@marleymoves.co.uk> wrote: " +
      "Marley Moves Your fixed price £1,856.40 | | | Accept online";
    expect(extractReplyText(raw)).toBe(
      "Yes please book it, and can your team park on the road out front? Thanks",
    );
  });

  it("does not cut on a customer's 'on the 14th'", () => {
    const raw =
      "Can you pack for us on the 14th? " +
      "On Fri, 1 Aug 2026 at 09:00, Luke at Marley Moves <luke@marleymoves.co.uk> wrote: quoted";
    expect(extractReplyText(raw)).toBe("Can you pack for us on the 14th?");
  });

  it("does not treat a customer's inline From/To/Date move details as an Outlook header", () => {
    const raw =
      "Hi Luke, please quote for a move. From: 12 High Street, Shaftesbury. To: Yeovil. Date: 15th August. Thanks, Mark";
    expect(extractReplyText(raw)).toBe(raw);
  });

  it("does not treat a customer's multi-line From/To/Date list as an Outlook header", () => {
    const raw = "Hi Luke\n\nFrom: 12 High Street, Shaftesbury\nTo: Yeovil BA20\nDate: 15 August\n\nThanks\nMark";
    expect(extractReplyText(raw)).toBe(raw);
  });

  it("does not delete a customer's '>' list (used as 'more than' / bullets)", () => {
    const raw = "We have a bit more than expected:\n> 30 boxes\n> a piano\nCan you still do it?";
    expect(extractReplyText(raw)).toBe(raw);
  });

  it("does not treat a customer's underscore divider as a quote boundary", () => {
    const raw =
      "Yes go ahead.\n________________________\nName: Mark Smith\nDate: 15 Aug\nItems: 30 boxes, sofa, bed";
    expect(extractReplyText(raw)).toBe(raw);
  });

  it("does not strip a mid-sentence 'sent from my'", () => {
    expect(extractReplyText("I sent from my work email earlier so please use this address instead")).toBe(
      "I sent from my work email earlier so please use this address instead",
    );
  });

  // --- quote/history removal (real client chrome) ---

  it("cuts a Gmail-style quoted reply and preserves the customer's line breaks", () => {
    const raw =
      "Hi Luke,\n\nYes Tuesday works great, thanks.\n\nCheers,\nSam\n\n" +
      "On Fri, 1 Aug 2026 at 09:00, Luke at Marley Moves <luke@marleymoves.co.uk> wrote:\n" +
      "> Your fixed price from Marley Moves\n> £1,856.40\n";
    expect(extractReplyText(raw)).toBe("Hi Luke,\n\nYes Tuesday works great, thanks.\n\nCheers,\nSam");
  });

  it("keeps a bottom-posted reply typed BELOW the quote", () => {
    const raw =
      "Hi Luke\n\n" +
      "On Sat, 1 Aug 2026 at 10:21, Luke at Marley Moves <luke@marleymoves.co.uk> wrote:\n" +
      "> Your fixed price\n> £1,856.40\n\n" +
      "Yes that's fine, please book us for the 15th and we'll pay the deposit today. Thanks, Mark";
    expect(extractReplyText(raw)).toBe(
      "Hi Luke\n\nYes that's fine, please book us for the 15th and we'll pay the deposit today. Thanks, Mark",
    );
  });

  it("keeps interleaved answers typed BETWEEN quoted questions", () => {
    const raw =
      "Hi Luke, answers below.\n\n" +
      "On Sat, 1 Aug 2026 at 10:21, Luke <luke@marleymoves.co.uk> wrote:\n" +
      "> What date do you need?\n15th August please\n" +
      "> How many items roughly?\nAbout 30 boxes and a sofa";
    expect(extractReplyText(raw)).toBe(
      "Hi Luke, answers below.\n\n15th August please\nAbout 30 boxes and a sofa",
    );
  });

  it("keeps interleaved answers even when the quote ends with a '>' CTA line", () => {
    // The worst prior case: a trailing quoted CTA made the old heuristic drop the
    // whole reply. Every answer must survive.
    const raw =
      "See my answers:\n\n" +
      "On Sat, 1 Aug 2026 at 10:21, Luke <luke@marleymoves.co.uk> wrote:\n" +
      "> Preferred date?\nThe 15th\n> Access ok?\nYes fine\n> Reply to confirm.";
    expect(extractReplyText(raw)).toBe("See my answers:\n\nThe 15th\nYes fine");
  });

  it("cuts an attribution written with a full weekday + month name", () => {
    const raw =
      "Please proceed.\n\nOn Friday, 1 August 2026 at 09:00, Luke <luke@marleymoves.co.uk> wrote:\nquoted";
    expect(extractReplyText(raw)).toBe("Please proceed.");
  });

  it("cuts an attribution with a numeric day + full month", () => {
    const raw =
      "Yes that's great.\n\nOn 12 September 2026, at 10:21, Luke <luke@marleymoves.co.uk> wrote:\n> quote";
    expect(extractReplyText(raw)).toBe("Yes that's great.");
  });

  // --- hard-wrapped attributions (Gmail wraps plain text at ~72 chars) ---

  it("strips a '>'-quoted history whose attribution is wrapped across two lines (MMR015)", () => {
    // The real Greig James payload shape, 2026-08-04: Gmail put "wrote:" on its
    // own line, the single-line attribution test failed, and the ENTIRE quoted
    // deposit email reached the office + the lead's comms log.
    const raw =
      "Hi Luke,\n\nPlease could you let me have 10 medium boxes, one roll of tape and a pack\nof paper - I can pick up from yours in Shaftesbury?\n\nMany thanks\nJames\n\n\n" +
      "On Tue, 4 Aug 2026 at 11:06, Marley Moves <accounts@marleymoves.co.uk>\nwrote:\n\n" +
      "> We've received your £100 deposit. Your move date is secured.\n> [image: Marley Moves]\n>\n> Hi Greig,\n> Thank you for booking with Marley Moves.\n";
    const out = extractReplyText(raw);
    expect(out).toBe(
      "Hi Luke,\n\nPlease could you let me have 10 medium boxes, one roll of tape and a pack\nof paper - I can pick up from yours in Shaftesbury?\n\nMany thanks\nJames",
    );
  });

  it("cuts a top-posted reply whose attribution is wrapped across three lines", () => {
    const raw =
      "Yes please book it, thanks.\n\n" +
      "On Tue, 4 Aug 2026 at\n11:06, Marley Moves\n<accounts@marleymoves.co.uk> wrote:\nYour fixed price from Marley Moves | | | Accept online";
    expect(extractReplyText(raw)).toBe("Yes please book it, thanks.");
  });

  it("still keeps a customer's own multi-line prose containing 'On' and an email address", () => {
    // No date shape after "On" and no "wrote:" → not an attribution, keep it all.
    const raw =
      "On arrival please call my partner\n<jane@example.com> for the gate code.\nThanks, Mark";
    expect(extractReplyText(raw)).toBe(raw);
  });

  it("processes a huge whitespace-padded body in linear time (no ReDoS on the public webhook)", () => {
    const raw = "Please quote for my move." + " ".repeat(200_000) + "thanks";
    const result = extractReplyText(raw);
    expect(result).toContain("Please quote for my move.");
    expect(result).toContain("thanks");
  });

  it("cuts an Outlook '-----Original Message-----' block", () => {
    const raw =
      "Please can you call me to discuss.\n\n-----Original Message-----\n" +
      "From: Luke <luke@marleymoves.co.uk>\nSent: 01 August 2026\nSubject: Your quote";
    expect(extractReplyText(raw)).toBe("Please can you call me to discuss.");
  });

  it("cuts a full Outlook From/Sent/Subject header block", () => {
    const raw =
      "Thanks, that works.\n\nFrom: Luke <luke@marleymoves.co.uk>\nSent: 01 August 2026 10:21\nTo: Mark\nSubject: Your quote\n\nYour fixed price…";
    expect(extractReplyText(raw)).toBe("Thanks, that works.");
  });

  it("strips a trailing device signature (whole line only)", () => {
    expect(extractReplyText("Sounds good, see you then.\n\nSent from my iPhone")).toBe(
      "Sounds good, see you then.",
    );
  });

  it("collapses table-pipe RUNS but leaves a lone pipe", () => {
    expect(extractReplyText("Job | | | at a glance")).toBe("Job at a glance");
    expect(extractReplyText("We need 5 | 6 crew")).toBe("We need 5 | 6 crew");
  });

  it("returns a clean reply unchanged when there's no quoted history", () => {
    expect(extractReplyText("Yes please go ahead.")).toBe("Yes please go ahead.");
  });

  it("returns empty for empty/null input (caller falls back to raw)", () => {
    expect(extractReplyText("")).toBe("");
    expect(extractReplyText(null)).toBe("");
    expect(extractReplyText(undefined)).toBe("");
  });
});

describe("splitReply (reply vs quoted history)", () => {
  it("returns the customer's words AND the quoted history separately", () => {
    const raw =
      "Hi Luke,\n\nYes Tuesday works great.\n\n" +
      "On Fri, 1 Aug 2026 at 09:00, Luke at Marley Moves <luke@marleymoves.co.uk> wrote:\n" +
      "> Your fixed price from Marley Moves\n> £1,856.40\n";
    const { reply, quoted } = splitReply(raw);
    expect(reply).toBe("Hi Luke,\n\nYes Tuesday works great.");
    expect(quoted).toContain("On Fri, 1 Aug 2026 at 09:00");
    expect(quoted).toContain("Your fixed price from Marley Moves");
    // ">" markers are stripped for clean rendering.
    expect(quoted).not.toMatch(/^>/m);
  });

  it("captures the wrapped-attribution quote (MMR015) in the quoted half", () => {
    const raw =
      "Please could I have 10 medium boxes?\n\n" +
      "On Tue, 4 Aug 2026 at 11:06, Marley Moves <accounts@marleymoves.co.uk>\nwrote:\n\n" +
      "> We've received your £100 deposit.\n> Your date and crew are now secured.\n";
    const { reply, quoted } = splitReply(raw);
    expect(reply).toBe("Please could I have 10 medium boxes?");
    expect(quoted).toContain("wrote:");
    expect(quoted).toContain("We've received your £100 deposit.");
  });

  it("returns an empty quoted half when there is no quote", () => {
    expect(splitReply("Yes please go ahead.")).toEqual({ reply: "Yes please go ahead.", quoted: "" });
    expect(splitReply("")).toEqual({ reply: "", quoted: "" });
  });
});

describe("htmlToText (HTML-only reply fallback)", () => {
  it("recovers the message from an HTML-only iPhone/Gmail reply (the MMR020 case)", () => {
    // Real shape: an HTML-only reply (empty text part) with the quoted quote
    // email inside a <blockquote>. Before the fallback this was lost entirely.
    const html = `<div dir="ltr">Hi,<div><br></div><div>Just to confirm, I&#39;ve accepted your quote and paid &pound;100 deposit.</div><div><br></div><div>Thank you very much!</div><div><br></div><div>Regards,<br>Priscilla</div><div><br></div><div>Sent from my iPhone</div></div>` +
      `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Sun, 3 Aug 2026 at 12:00, Marley Moves &lt;q-abc@reply.marleymoves.co.uk&gt; wrote:<br></div>` +
      `<blockquote class="gmail_quote"><div>Your fixed price from Marley Moves: £2,100. | | | Accept your quote online →</div></blockquote></div>`;
    const flattened = htmlToText(html);
    // The quoted quote-email table wall is gone.
    expect(flattened).not.toContain("| |");
    expect(flattened).not.toContain("Accept your quote online");
    // Feeding it through extractReplyText strips the surviving attribution line
    // and the "Sent from my iPhone" tagline, leaving just the customer's words.
    const message = extractReplyText(flattened);
    expect(message).toContain("I've accepted your quote and paid £100 deposit");
    expect(message).toContain("Regards,");
    expect(message).not.toContain("wrote:");
    expect(message).not.toContain("Sent from my iPhone");
  });

  it("turns block tags into line breaks and decodes entities", () => {
    const out = htmlToText("<p>Line one</p><div>Line two</div>Tom &amp; Jerry &lt;3 &#39;quote&#39;");
    expect(out).toBe("Line one\nLine two\nTom & Jerry <3 'quote'");
  });

  it("drops script/style and blockquote quoted history", () => {
    const out = htmlToText(
      `<style>.x{color:red}</style><p>Real message</p><blockquote>old quoted thread that should vanish</blockquote>`,
    );
    expect(out).toContain("Real message");
    expect(out).not.toContain("old quoted thread");
    expect(out).not.toContain("color:red");
  });

  it("returns empty for empty/null/undefined", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });

  it("stays linear on a large unclosed-tag body (no catastrophic backtracking)", () => {
    const big = "<blockquote>" + "a ".repeat(100_000); // never closed
    const start = performance.now();
    const out = htmlToText(big);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(typeof out).toBe("string");
  });
});
