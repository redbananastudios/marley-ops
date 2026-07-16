import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { JOB_MEDIA_BUCKET } from "@/lib/job-media";
import type { JobMediaView } from "@/components/content/job-media-list";

/** Load captured job content with signed URLs (1h) — office review surfaces. */
export async function loadJobMedia(opts: {
  leadId?: string;
  filter?: "needs-review" | "approved" | "internal";
  limit?: number;
}): Promise<JobMediaView[]> {
  const admin = createAdminClient();
  let q = admin
    .from("job_media")
    .select(
      "id, lead_id, kind, storage_path, caption, tag, consent_state, transcript, transcript_status, captured_by_name, created_at, marketing_approved_at, leads(name)",
    )
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.leadId) q = q.eq("lead_id", opts.leadId);
  if (opts.filter === "approved") q = q.not("marketing_approved_at", "is", null);
  if (opts.filter === "needs-review")
    q = q.is("marketing_approved_at", null).neq("consent_state", "internal_only");
  if (opts.filter === "internal") q = q.eq("consent_state", "internal_only");

  const { data } = await q;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: signed } = await admin.storage
    .from(JOB_MEDIA_BUCKET)
    .createSignedUrls(rows.map((r) => r.storage_path as string), 3600);
  const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  return rows
    .map((r) => ({
      id: r.id as string,
      kind: r.kind as JobMediaView["kind"],
      url: urlByPath.get(r.storage_path as string) ?? "",
      caption: (r.caption as string) ?? "",
      tag: (r.tag as string | null) ?? null,
      consentState: (r.consent_state as string) ?? "unset",
      transcript: (r.transcript as string | null) ?? null,
      transcriptStatus: (r.transcript_status as string) ?? "none",
      capturedByName: (r.captured_by_name as string) || "Team",
      createdAt: r.created_at as string,
      approvedAt: (r.marketing_approved_at as string | null) ?? null,
      leadId: r.lead_id as string,
      leadName: ((r.leads as { name?: string | null } | null)?.name as string | null) ?? null,
    }))
    .filter((r) => r.url);
}
