import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("final-release reliability invariants", () => {
  it("paginates both growing removal-calendar datasets deterministically", () => {
    const source = read("app/(dashboard)/schedule/removals/page.tsx");
    // Three paged reads: the two strict calendar datasets (appointments,
    // leads — pinned exactly below) plus the bare-client picker, which pages
    // fail-soft like every other clients picker (/storage).
    expect(source.match(/fetchAllRows\(/g)).toHaveLength(3);
    expect(source.match(/\.range\(from, to\)/g)).toHaveLength(2);
    expect(source.match(/\.order\("id", \{ ascending: true \}\)/g)).toHaveLength(2);
    expect(source.match(/\{ strict: true \}/g)).toHaveLength(2);
  });

  it("claims communications and inbound webhooks before provider side effects", () => {
    const dispatch = read("lib/comms/dispatch.ts");
    expect(dispatch.indexOf("claimCommunication(sb")).toBeLessThan(dispatch.indexOf("await sendEmail({"));
    expect(dispatch).toContain("marley-comm/${communicationId}");
    expect(dispatch).toContain("provider_payload_hash: providerPayloadHash");

    const webhook = read("app/api/webhooks/resend-inbound/route.ts");
    expect(webhook.indexOf('rpc("claim_webhook_event"')).toBeLessThan(
      webhook.indexOf("const outcome = await processInbound(sb"),
    );
    expect(webhook).toContain("payload_mismatch");
    expect(webhook).toContain("p_payload_hash: emailPayloadHash(input)");
    expect(webhook).toContain("marley-inbound-forward/${eventId}");
  });

  it("ships atomic SQL claims and daily operational issue checkpoints", () => {
    const migration = read("supabase/migrations/0070_delivery_claims_and_operational_issues.sql");
    expect(migration).toContain("communications_dispatch_key_uq");
    expect(migration).toContain("claim_webhook_event");
    expect(migration).toContain("finalize_communication_send");
    expect(migration).toContain("operational_issue_daily_updates");
    expect(migration).toContain("checkpoint_operational_issues");
  });
});
