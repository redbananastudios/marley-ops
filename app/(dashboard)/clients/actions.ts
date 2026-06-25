"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { attachOrCreateClient, findExistingClient } from "@/lib/leads/resolver";

async function actor() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** Live dedupe check for the Add-client dialog. Read-only. */
export async function checkClientDuplicateAction(input: { phone?: string; email?: string }) {
  const { sb } = await actor();
  const match = await findExistingClient(sb, input);
  if (!match) return { matched: false as const };
  return {
    matched: true as const,
    clientName: match.client.display_name,
    previousLeadCount: match.previousLeadCount,
  };
}

/** Create a client directly (manual entry). Dedupes on phone/email — if a live
 *  client already matches, returns that one rather than a duplicate. */
export async function createClientAction(input: {
  name: string;
  phone?: string;
  email?: string;
  postcode?: string;
}) {
  const name = input.name?.trim();
  if (!name) return { ok: false as const, error: "A name is required." };

  const { sb, userId } = await actor();
  try {
    const { clientId, matched } = await attachOrCreateClient(sb, {
      name,
      phone: input.phone,
      email: input.email,
      postcode: input.postcode,
    });

    if (!matched) {
      await sb.from("activities").insert({
        client_id: clientId,
        actor_id: userId,
        type: "note",
        summary: "Client added manually",
      });
    }

    revalidatePath("/clients");
    return { ok: true as const, clientId, matched };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Could not add client." };
  }
}
