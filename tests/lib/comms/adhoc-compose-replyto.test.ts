import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapBrand, type Brand } from "@/lib/brand";
import { pitmans } from "./brand-fixture";

/**
 * The office ad-hoc compose (app/actions/send-email.ts) set the tokenless
 * Reply-To to the COMPOSER's own marleymoves.co.uk mailbox regardless of the
 * customer's brand — so a one-off email fronting Pitmans' door invited replies
 * straight into Marley's. Brand-first, like the rest of comms: only a DEFAULT
 * brand compose keeps the composer's mailbox; a non-default brand leaves the
 * Reply-To to the send path's brand fallback (emailReplyToFor), and the
 * tokenized panel relay still wins for either brand when the lead has one.
 */

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const marley: Brand = mapBrand({
  slug: "marley",
  name: "Marley Moves",
  short_name: "Marley",
  card_payments_enabled: true,
});

const state = {
  leadBrand: null as string | null,
  acceptToken: null as string | null,
};

const dispatched = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({
    id: "office-1",
    fullName: "Connor Marley",
    email: "connor@marleymoves.co.uk",
    role: "admin",
    accessToken: "t",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "order", "limit"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () =>
        table === "leads"
          ? { data: { brand: state.leadBrand }, error: null }
          : { data: state.acceptToken ? { accept_token: state.acceptToken } : null, error: null };
      return chain;
    },
  }),
}));
vi.mock("@/lib/comms/brand-theme", () => ({
  brandForComms: async (_sb: unknown, slug: string | null) =>
    slug === "pitmans" ? pitmans : marley,
}));
vi.mock("@/lib/comms/dispatch", () => ({
  dispatchComm: (...args: unknown[]) => dispatched(...args),
}));

import { sendAdHocEmailAction } from "@/app/actions/send-email";

const input = {
  to: "customer@example.com",
  subject: "About your move",
  message: "Hello there.",
  leadId: LEAD,
};

const lastDispatch = () => dispatched.mock.calls.at(-1)![2] as Record<string, unknown>;

describe("ad-hoc compose Reply-To follows the customer's brand", () => {
  beforeEach(() => {
    dispatched.mockClear();
    state.leadBrand = null;
    state.acceptToken = null;
  });

  it("a tokenless Pitmans compose never carries a marleymoves.co.uk Reply-To", async () => {
    state.leadBrand = "pitmans";
    const res = await sendAdHocEmailAction(input);
    expect(res).toEqual({ ok: true });
    const sent = lastDispatch();
    // The From already fronts the brand's own door…
    expect(sent.from).toBe("Pitmans Removals & Storage <info@pitmansremovals.co.uk>");
    // …and the Reply-To must not yank the reply back to a Marley mailbox: it is
    // left unset so the send path resolves the brand's hello identity.
    expect(sent.replyTo).toBeUndefined();
    expect((sent.brand as Brand).slug).toBe("pitmans");
  });

  it("a tokenless Marley compose keeps replies with the composer (unchanged)", async () => {
    state.leadBrand = null; // unlinked/marley lead resolves to the default brand
    await sendAdHocEmailAction(input);
    const sent = lastDispatch();
    expect(sent.replyTo).toBe("connor@marleymoves.co.uk");
    expect(sent.from).toBe("Connor at Marley Moves <connor@marleymoves.co.uk>");
  });

  it("the tokenized panel relay still wins for a Marley lead with a quote token", async () => {
    state.acceptToken = "tokMARLEY1";
    await sendAdHocEmailAction(input);
    expect(lastDispatch().replyTo).toBe("Marley Moves <q-tokMARLEY1@reply.marleymoves.co.uk>");
  });

  it("the tokenized panel relay still wins for a Pitmans lead with a quote token", async () => {
    state.leadBrand = "pitmans";
    state.acceptToken = "tokPIT1";
    await sendAdHocEmailAction(input);
    expect(lastDispatch().replyTo).toBe(
      "Pitmans Removals & Storage <q-tokPIT1@reply.marleymoves.co.uk>",
    );
  });
});
