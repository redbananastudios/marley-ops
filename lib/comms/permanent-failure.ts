/**
 * Is a stored provider error one that can NEVER succeed on a re-drive?
 *
 * Two retry layers exist. Layer 1 (in-process, `shouldRetryResendAttempt`)
 * already refuses to retry a definite reject. Layer 2 — the durable comms-retry
 * worker — selects purely on `status='failed'` and `attempt_count < 8`, and
 * re-drives the STORED payload. It never asks whether the failure was permanent.
 *
 * So a deterministic rejection burns the full attempt ladder against a payload
 * that is guaranteed to fail identically every time. That is exactly what
 * happened to MMR034's move-date confirmation on 2026-08-05: a template variable
 * exceeded Resend's 2,000-character limit, and the worker re-drove it eight
 * times over two days before a human was finally told — during which the
 * customer had no confirmation and no invoice, and nothing said so.
 *
 * Escalating on the FIRST such failure gets a person involved hours earlier and
 * stops the pointless churn. Composition bugs are also fixed by re-composing,
 * never by resending the same bytes, so retrying cannot help by definition.
 *
 * Conservative by design: anything not clearly permanent keeps retrying. A
 * wrongly-permanent verdict still reaches a human (just sooner), but a wrongly
 * transient verdict on a genuine outage would be the retry layer doing its job,
 * so the cost of a false "permanent" is the higher one to avoid.
 */

/** Markers that mean "the request itself is malformed or unacceptable". */
const PERMANENT_MARKERS = [
  "character limit", // Resend: template variable / field length caps
  "validation_error",
  "validation failed",
  "invalid `to`",
  "invalid `from`",
  "invalid `reply_to`",
  "invalid email",
  "not a valid email",
  "must be a valid email",
  "invalid recipient",
  "missing required field",
  "unsupported file type",
  "attachment too large",
  "payload too large",
  "request entity too large",
];

export function isPermanentProviderError(error: string | null | undefined): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return PERMANENT_MARKERS.some((marker) => text.includes(marker));
}
