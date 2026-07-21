import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { Database, Json } from "@/lib/supabase/database.types";
import { errorContext, log, redactedLogContext, type LogContext } from "@/lib/log";
import { sendEmail } from "@/lib/comms/send";
import { opsAlertRecipient } from "@/lib/comms/sender";

type Sb = SupabaseClient<Database>;
export type IssueSeverity = "info" | "warning" | "error" | "critical";

export interface OperationalIssueRow {
  id: string;
  issue_key: string;
  severity: IssueSeverity;
  source: string;
  event: string;
  message: string;
  context?: Json;
  status: "open" | "resolved";
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  last_checkpoint_at: string | null;
  resolved_at: string | null;
}

type DigestIssue = Pick<OperationalIssueRow, "issue_key" | "severity" | "message" | "occurrence_count" | "last_seen_at">;
type DigestPayload = {
  issues: DigestIssue[];
  totalCount: number;
  omittedCount: number;
};

function readDigestPayload(value: Json): DigestPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, Json | undefined>;
  if (!Array.isArray(candidate.issues) || typeof candidate.totalCount !== "number" || typeof candidate.omittedCount !== "number") {
    return null;
  }
  const issues = candidate.issues.filter((item): item is Record<string, Json> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  if (issues.length !== candidate.issues.length || issues.some((item) =>
    typeof item.issue_key !== "string" ||
    !["info", "warning", "error", "critical"].includes(String(item.severity)) ||
    typeof item.message !== "string" ||
    typeof item.occurrence_count !== "number" ||
    typeof item.last_seen_at !== "string"
  )) return null;
  return {
    issues: issues as unknown as DigestIssue[],
    totalCount: candidate.totalCount,
    omittedCount: candidate.omittedCount,
  };
}

export async function reportOperationalIssue(
  sb: Sb,
  issue: {
    key: string;
    severity: IssueSeverity;
    source: string;
    event: string;
    message: string;
    context?: LogContext;
  },
): Promise<void> {
  const method = issue.severity === "info" ? "info" : issue.severity === "warning" ? "warn" : "error";
  log[method](issue.event, { issueKey: issue.key, source: issue.source, ...(issue.context ?? {}) });
  try {
    const { error } = await sb.rpc("report_operational_issue", {
      p_issue_key: issue.key,
      p_severity: issue.severity,
      p_source: issue.source,
      p_event: issue.event,
      p_message: issue.message,
      p_context: redactedLogContext(issue.context ?? {}) as Json,
    });
    if (error) log.warn("ops.issue.persist_failed", { issueKey: issue.key, error: error.message });
  } catch (error) {
    log.warn("ops.issue.persist_threw", { issueKey: issue.key, ...errorContext(error) });
  }
}

export async function resolveOperationalIssue(sb: Sb, issueKey: string): Promise<void> {
  try {
    const { error } = await sb.rpc("resolve_operational_issue", { p_issue_key: issueKey });
    if (error) log.warn("ops.issue.resolve_failed", { issueKey, error: error.message });
  } catch (error) {
    log.warn("ops.issue.resolve_threw", { issueKey, ...errorContext(error) });
  }
}

/** One upserted snapshot per open issue and UK business day. */
export async function checkpointOperationalIssues(sb: Sb, now = new Date()): Promise<number> {
  const dateKey = (at: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const snapshotDate = dateKey(now);
  try {
    const { data: open, error: readError } = await sb
      .from("operational_issues")
      .select("last_seen_at,last_checkpoint_at")
      .eq("status", "open");
    if (readError) throw readError;
    if (!open?.length) return 0;
    if (open.every((issue) =>
      issue.last_checkpoint_at &&
      dateKey(new Date(issue.last_checkpoint_at)) === snapshotDate &&
      new Date(issue.last_checkpoint_at).getTime() >= new Date(issue.last_seen_at).getTime(),
    )) return open.length;

    const { data, error } = await sb.rpc("checkpoint_operational_issues", { p_snapshot_date: snapshotDate });
    if (error) {
      log.warn("ops.issue.checkpoint_failed", { snapshotDate, error: error.message });
      return 0;
    }
    const count = Number(data ?? 0);
    log.info("ops.issue.daily_checkpoint", { snapshotDate, openIssueCount: count });
    return count;
  } catch (error) {
    log.warn("ops.issue.checkpoint_threw", { snapshotDate, ...errorContext(error) });
    return 0;
  }
}

export async function deliverDailyOperationalIssueDigest(
  sb: Sb,
  now = new Date(),
): Promise<"sent" | "simulated" | "already-sent" | "none" | "failed"> {
  const snapshotDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const { data: issues, count, error: issuesError } = await sb
    .from("operational_issues")
    .select("issue_key,severity,message,occurrence_count,last_seen_at", { count: "exact" })
    .eq("status", "open")
    .order("last_seen_at", { ascending: false })
    .limit(50);
  if (issuesError) {
    log.warn("ops.issue.digest_read_failed", { snapshotDate, error: issuesError.message });
    return "failed";
  }
  if (!issues?.length) return "none";
  const totalCount = count ?? issues.length;
  const proposedPayload: DigestPayload = {
    issues: issues as DigestIssue[],
    totalCount,
    omittedCount: Math.max(0, totalCount - issues.length),
  };
  const { data: claims, error: claimError } = await sb.rpc("claim_operational_issue_digest", {
    p_snapshot_date: snapshotDate,
    p_issue_count: totalCount,
    p_payload: proposedPayload as unknown as Json,
    p_payload_hash: createHash("sha256").update(JSON.stringify(proposedPayload)).digest("hex"),
    p_retry_simulated: process.env.COMMS_DRYRUN !== "true",
    p_lease_seconds: 300,
  });
  const claim = claims?.[0];
  if (claimError || !claim) {
    log.warn("ops.issue.digest_claim_failed", { snapshotDate, error: claimError?.message ?? "No claim result" });
    return "failed";
  }
  if (claim.decision === "sent" || claim.decision === "busy") return "already-sent";
  if (claim.decision === "simulated") return "simulated";
  if (claim.decision !== "claimed" || !claim.digest_claim_token) {
    log.warn("ops.issue.digest_claim_invalid", { snapshotDate, decision: claim.decision });
    return "failed";
  }
  const payload = readDigestPayload(claim.digest_payload);
  if (!payload) {
    const { error: failError } = await sb.rpc("fail_operational_issue_digest", {
      p_snapshot_date: snapshotDate,
      p_claim_token: claim.digest_claim_token,
      p_error: "Stored digest payload is invalid",
    });
    log.warn("ops.issue.digest_payload_invalid", { snapshotDate, error: failError?.message });
    return "failed";
  }

  const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const result = await sendEmail({
    to: opsAlertRecipient("system"),
    subject: `[Marley Ops] Daily operational issues — ${payload.totalCount} open`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6"><p>${payload.totalCount} operational issue${payload.totalCount === 1 ? " is" : "s are"} open:</p><ul>${payload.issues
      .map((issue) => `<li><strong>${esc(issue.severity.toUpperCase())}</strong> ${esc(issue.message)} (${issue.occurrence_count})</li>`)
      .join("")}</ul>${payload.omittedCount ? `<p>Plus ${payload.omittedCount} more open issue${payload.omittedCount === 1 ? "" : "s"}.</p>` : ""}<p><a href="https://ops.marleymoves.co.uk/automations">Open Marley Ops automations</a></p></div>`,
    idempotencyKey: `marley-ops-daily/${snapshotDate}`,
  });
  if (!result.ok) {
    const { data: failed, error: failError } = await sb.rpc("fail_operational_issue_digest", {
      p_snapshot_date: snapshotDate,
      p_claim_token: claim.digest_claim_token,
      p_error: result.error ?? "Delivery failed",
    });
    await reportOperationalIssue(sb, {
      key: `ops-digest:${snapshotDate}`,
      severity: "error",
      source: "health-watchdog",
      event: "ops.issue.digest_failed",
      message: "The daily operational issue digest could not be delivered.",
      context: { snapshotDate, error: result.error, digestStateRecorded: !failError && failed === true },
    });
    return "failed";
  }

  const completionRpc = result.simulated
    ? "simulate_operational_issue_digest" as const
    : "complete_operational_issue_digest" as const;
  const { data: completed, error: completionError } = await sb.rpc(completionRpc, {
    p_snapshot_date: snapshotDate,
    p_claim_token: claim.digest_claim_token,
  });
  if (completionError || !completed) {
    await reportOperationalIssue(sb, {
      key: `ops-digest:${snapshotDate}`,
      severity: "error",
      source: "health-watchdog",
      event: "ops.issue.digest_finalize_failed",
      message: "The daily operational issue digest provider result could not be finalized.",
      context: { snapshotDate, error: completionError?.message, simulated: result.simulated === true },
    });
    return "failed";
  }
  if (result.simulated) {
    log.info("ops.issue.digest_simulated", { snapshotDate, openIssueCount: payload.totalCount });
    return "simulated";
  }
  await resolveOperationalIssue(sb, `ops-digest:${snapshotDate}`);
  log.info("ops.issue.digest_sent", { snapshotDate, openIssueCount: payload.totalCount });
  return "sent";
}
