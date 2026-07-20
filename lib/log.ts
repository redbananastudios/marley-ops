/**
 * Structured logging for production maintainability.
 *
 * Every log line is a single JSON object on one line — greppable and parseable
 * in Vercel's function logs (and any log drain). Always pass an `event` slug
 * (dot-namespaced, e.g. "cron.run", "comm.send.failed") plus a context object;
 * never interpolate values into the message. That way you can filter by event
 * and read the structured fields instead of regexing prose.
 *
 *   import { log } from "@/lib/log";
 *   log.info("cron.run", { job: "chase", ok: true, durationMs: 812 });
 *   log.error("comm.send.failed", { channel: "email", leadId, error: msg });
 *
 * Levels map to console methods so Vercel colours/《severity》 them correctly.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;
const MAX_STRING = 2_000;
const MAX_LINE = 16_000;
const SECRET_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|signature|(^|_)(to|from|email|phone|recipient|address)(_|$))/i;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_VALUE = /(?<!\d)(?:\+44\s?\d{4}|0\d{4})[\s()-]*\d{3}[\s-]*\d{3}(?!\d)/g;

function sanitiseString(value: string): string {
  const redacted = value.replace(EMAIL_VALUE, "[redacted-email]").replace(PHONE_VALUE, "[redacted-phone]");
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
}

function sanitise(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitiseString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[max-depth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY).map((item) => sanitise(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) result.push(`[${value.length - MAX_ARRAY} more]`);
    return result;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries.slice(0, MAX_KEYS)) {
    output[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitise(child, depth + 1, seen);
  }
  if (entries.length > MAX_KEYS) output._truncatedKeys = entries.length - MAX_KEYS;
  return output;
}

function safeStringify(obj: unknown): string {
  try {
    const safe = sanitise(obj, 0, new WeakSet());
    const line = JSON.stringify(safe);
    if (line.length <= MAX_LINE) return line;
    const canonical = safe as Record<string, unknown>;
    return JSON.stringify({
      schemaVersion: canonical.schemaVersion,
      service: canonical.service,
      environment: canonical.environment,
      release: canonical.release,
      level: canonical.level,
      event: canonical.event,
      ts: canonical.ts,
      contextTruncated: true,
      originalLength: line.length,
    });
  } catch {
    return JSON.stringify({ error: "log_serialisation_failed" });
  }
}

/** Reuse the same redaction/size policy before persisting structured context. */
export function redactedLogContext(ctx: LogContext): LogContext {
  return sanitise(ctx, 0, new WeakSet()) as LogContext;
}

function emit(level: LogLevel, event: string, ctx?: LogContext): void {
  // Canonical fields are written last so callers cannot spoof severity/event/time.
  const line = safeStringify({
    ...(ctx ?? {}),
    schemaVersion: 1,
    service: "marley-ops",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.npm_package_version ?? "unknown",
    level,
    event,
    ts: new Date().toISOString(),
  });
  // Route to the matching console method so log drains get the right severity.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Normalise any thrown value to a message + optional stack for logging. */
export function errorContext(e: unknown): { error: string; stack?: string } {
  if (e instanceof Error) return { error: e.message, stack: e.stack };
  return { error: String(e) };
}

export const log = {
  debug: (event: string, ctx?: LogContext) => emit("debug", event, ctx),
  info: (event: string, ctx?: LogContext) => emit("info", event, ctx),
  warn: (event: string, ctx?: LogContext) => emit("warn", event, ctx),
  error: (event: string, ctx?: LogContext) => emit("error", event, ctx),
};
