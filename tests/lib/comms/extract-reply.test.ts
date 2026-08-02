import { describe, it, expect } from "vitest";
import { extractReplyText } from "@/lib/comms/extract-reply";

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
