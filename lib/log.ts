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

/** Trim deep/large context so a stray object can't blow up a log line. */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ _unserialisable: String(obj) });
  }
}

function emit(level: LogLevel, event: string, ctx?: LogContext): void {
  const line = safeStringify({ level, event, ts: new Date().toISOString(), ...ctx });
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
