import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import { JOB_MEDIA_BUCKET } from "@/lib/job-media";
import type { JobMediaView } from "@/components/content/job-media-list";

/** Load captured job content with signed URLs (24h — a review tab left open
 *  overnight has no re-sign path, so playback/lightbox links must outlive it;
 *  office-only surfaces, so the longer TTL is acceptable). */
export async function loadJobMedia(opts: {
  leadId?: string;
  filter?: "needs-review" | "approved" | "internal";
  limit?: number;
  /** Active-brand slug to narrow to (multi-brand PRD §4 Content). ADDITIVE:
   *  omitted = off, and the query is byte-identical to before the param
   *  existed — existing callers see zero behaviour change. When set, the
   *  narrowing runs IN the DB so the newest-N window is computed WITHIN the
   *  brand, not sliced out of a brand-blind window afterwards. */
  brand?: string;
}): Promise<JobMediaView[]> {
  const admin = createAdminClient();
  // A named brand flips the leads embed to an INNER join in the query string:
  // filtering an ordinary left-join embed (.eq("leads.brand", …) over
  // leads(name)) narrows the embedded row, not the job_media parent, so the
  // window would stay brand-blind. The embed variant is chosen at runtime; the
  // cast pins the static row type to the un-narrowed shape — the fields this
  // function reads are identical in both variants.
  const embed: string = opts.brand ? "leads!inner(name, brand)" : "leads(name)";
  let q = admin
    .from("job_media")
    .select(
      `id, lead_id, kind, storage_path, caption, tag, consent_state, transcript, transcript_status, captured_by_name, created_at, marketing_approved_at, ${embed}` as "id, lead_id, kind, storage_path, caption, tag, consent_state, transcript, transcript_status, captured_by_name, created_at, marketing_approved_at, leads(name)",
    )
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.leadId) q = q.eq("lead_id", opts.leadId);
  if (opts.brand) q = q.eq("leads.brand", opts.brand);
  if (opts.filter === "approved") q = q.not("marketing_approved_at", "is", null);
  if (opts.filter === "needs-review")
    q = q.is("marketing_approved_at", null).neq("consent_state", "internal_only");
  if (opts.filter === "internal") q = q.eq("consent_state", "internal_only");

  const { data, error } = await q;
  // A brand-narrowed load must fail LOUD: the caller renders that brand's
  // filtered view from exactly this result, so a swallowed error would render
  // "no content" for the brand (the "I could not check" rule). Un-narrowed
  // callers keep the previous fail-soft empty result.
  if (error && opts.brand) throw new Error(`job media brand read failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  // Sign through the seam (follows the active driver — R2 in prod). One key at
  // a time; a failed sign drops that one item rather than the whole page.
  const store = createMediaStore(process.env, { bucket: JOB_MEDIA_BUCKET });
  const signed = await Promise.all(
    rows.map(async (r) => {
      const path = r.storage_path as string;
      try {
        return { path, signedUrl: await store.createSignedGetUrl(path, 86400) };
      } catch {
        return { path, signedUrl: null as string | null };
      }
    }),
  );
  const urlByPath = new Map(signed.map((s) => [s.path, s.signedUrl]));

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
