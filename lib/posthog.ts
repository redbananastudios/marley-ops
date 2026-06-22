/**
 * PostHog read layer (server-only) — pulls the Marley website behaviour funnel
 * so the dashboard can show where visitors fall off before becoming a lead.
 *
 * Uses the Personal API key (read) against project 202362 (EU). The funnel is the
 * clean monotonic path: site visit -> quote started -> enquiry submitted.
 * `step1_submit` is deliberately excluded (it fires inconsistently across the
 * live form variants, so it under-counts vs generate_lead and would read as a
 * broken funnel). call_click / whatsapp_click are surfaced as direct-contact side
 * conversions, not funnel steps.
 *
 * Every call is wrapped so a slow/unavailable PostHog never breaks the dashboard:
 * a timeout or any error yields null and the UI shows a soft "unavailable" state.
 */

import "server-only";

export interface WebsiteFunnel {
  visited: number;
  started: number;
  enquiry: number;
  callClicks: number;
  whatsappClicks: number;
}

const FUNNEL_EVENTS = ["$pageview", "lead_start", "generate_lead", "call_click", "whatsapp_click"] as const;

/** ClickHouse-friendly UTC timestamp: 'YYYY-MM-DD HH:MM:SS'. */
function chTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Fetch the website funnel event counts for [from, to). Returns null on any
 * failure (missing key, timeout, non-200, parse error) — callers degrade gracefully.
 */
export async function fetchWebsiteFunnel(from: Date, to: Date): Promise<WebsiteFunnel | null> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.MARLEY_POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_API_HOST || "https://eu.posthog.com";
  if (!key || !projectId) return null;

  const eventList = FUNNEL_EVENTS.map((e) => `'${e}'`).join(",");
  const query = `select event, count() as c from events where event in (${eventList}) and timestamp >= toDateTime('${chTime(
    from,
  )}') and timestamp < toDateTime('${chTime(to)}') group by event`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: [string, number][] };
    const rows = data.results ?? [];
    const get = (event: string): number => rows.find((r) => r[0] === event)?.[1] ?? 0;
    return {
      visited: get("$pageview"),
      started: get("lead_start"),
      enquiry: get("generate_lead"),
      callClicks: get("call_click"),
      whatsappClicks: get("whatsapp_click"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
