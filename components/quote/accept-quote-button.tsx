"use client";

/**
 * The staff-side conversion (customer said yes on the phone). One confirm
 * dialog, then the full booking machine runs.
 *
 * RESIDENTIAL — "Accept quote": agreed price locked, lead to Provisional,
 * £deposit requested with the payment email sent to the customer, Zoho deposit
 * invoice raised. The lead confirms itself when the deposit lands, and the job
 * appears in Bookings → Awaiting deposit.
 *
 * COMMERCIAL — "Confirm booking" (PRD §3.10): the office confirms, because a
 * commercial quote has no accept action on /q and takes no signature. No
 * deposit is asked for, no invoice is raised, and NOTHING is sent to the
 * customer — they hear from us next when the completion invoice goes out.
 *
 * The server already behaved correctly for commercial before this component
 * did: acceptQuoteByStaff writes deposit 0, skips the deposit email, skips the
 * day-5 call task and logs "business terms — no deposit, invoiced on
 * completion". The dialog described the residential machine anyway. That gap
 * mattered because this button is the ONLY route by which a commercial booking
 * can be confirmed at all, so the one screen the office must trust was the one
 * telling them a deposit email was about to reach a business client. It also
 * demanded a deposit "to request" that the server would discard, and refused to
 * proceed on 0 — the honest answer typed into a required field.
 *
 * `compact` renders the small quotes-list trigger; default is the quote-page
 * header button.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { acceptQuote, quotePaymentPolicy } from "@/app/(dashboard)/quotes/actions";

const gbp = (n: number): string => "£" + Number(n).toLocaleString("en-GB");

type Policy = "residential" | "commercial";

export function AcceptQuoteButton({
  quoteId,
  grandTotal,
  status,
  depositAmount = 100,
  paymentPolicy,
  compact,
  className,
}: {
  quoteId: string;
  grandTotal: number;
  status: string;
  /** Settings defaultDeposit — shown in the dialog so the amount is never a surprise. */
  depositAmount?: number;
  /** Seed from a caller that already resolved it server-side (the quote detail
   *  page does). Absent is the normal case — the quotes LIST holds no client
   *  join, and `quotes.payment_policy` is null on every unaccepted row, so
   *  there is nothing on a list row to read this from. The dialog therefore
   *  resolves it itself on open; this prop only spares the round trip. */
  paymentPolicy?: Policy;
  compact?: boolean;
  /** Extra classes on the default (non-compact) trigger — lets the quote header
   *  size it as the page's primary CTA (h-11, full-width on mobile). */
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(grandTotal ?? 0));
  const [deposit, setDeposit] = useState(String(depositAmount));
  const [busy, setBusy] = useState(false);
  /**
   * null = not yet known, "failed" = could not be read. The dialog stays
   * un-actionable in both: showing the residential deposit field and swapping
   * it a moment later would put a figure in front of the office that it then
   * takes away, and an office that clicked in that window would have confirmed
   * against the wrong description of what happens next.
   *
   * One tri-state rather than a policy plus a `failed` flag, so the reset on
   * re-open is a single assignment made from the OPEN handler — a plain
   * `setPolicyFailed(false)` in the effect body is a synchronous setState in an
   * effect, which is both a lint warning here and a cascading render.
   */
  const [policy, setPolicy] = useState<Policy | "failed" | null>(paymentPolicy ?? null);
  const policyFailed = policy === "failed";
  const resolved = policy === "residential" || policy === "commercial";

  /** Open, resetting any previous failed read so re-opening retries. */
  const openDialog = (v: boolean) => {
    if (v) setPolicy(paymentPolicy ?? null);
    setOpen(v);
  };

  useEffect(() => {
    if (open) {
      setPrice(String(grandTotal ?? 0));
      setDeposit(String(depositAmount));
    }
  }, [open, grandTotal, depositAmount]);

  // Resolve on open, every time — a client can be re-typed between one opening
  // and the next, and this dialog is where that changes what the button does.
  useEffect(() => {
    if (!open || paymentPolicy) return;
    let live = true;
    quotePaymentPolicy(quoteId)
      .then((res) => {
        if (!live) return;
        setPolicy(res.ok ? res.policy : "failed");
      })
      .catch(() => {
        // Refusing to guess is the point. A failed read that fell back to
        // residential would show a deposit field for a business client and
        // send them a payment email — the exact outcome this whole change
        // exists to prevent — and it would do it silently.
        if (live) setPolicy("failed");
      });
    return () => {
      live = false;
    };
  }, [open, quoteId, paymentPolicy]);

  // Only live quotes convert; accepted ones link to Bookings from elsewhere.
  if (status !== "draft" && status !== "sent") return null;

  const commercial = policy === "commercial";
  const verb = commercial ? "Confirm booking" : "Accept quote";

  async function confirm() {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the agreed price.");
      return;
    }
    // Commercial has no deposit rung, so there is no field and nothing to
    // validate. The old guards ran regardless and BLOCKED on 0 — the office
    // could only confirm a commercial booking by typing a deposit figure that
    // the server then discarded.
    let dep: number | undefined;
    if (!commercial) {
      dep = Number(deposit);
      if (!Number.isFinite(dep) || dep <= 0) {
        toast.error("Enter the deposit to request.");
        return;
      }
      if (dep >= value) {
        toast.error("The deposit must be less than the agreed price.");
        return;
      }
    }
    setBusy(true);
    try {
      const res = await acceptQuote(quoteId, value, dep);
      if (!res.ok) {
        toast.error(res.error || `Could not ${commercial ? "confirm the booking" : "accept the quote"}.`);
        return;
      }
      toast.success(
        commercial
          ? `Booking confirmed — ${gbp(res.agreedPrice)} on account. Nothing sent to the customer; invoice it from Bookings when the job is done.`
          : `Accepted — ${gbp(res.agreedPrice)} booked. ${
              res.emailed
                ? `Payment email sent (${gbp(res.deposit ?? depositAmount)} deposit).`
                : "No customer email on file — send the payment link from Bookings."
            }`,
      );
      setOpen(false);
      router.refresh();
    } catch {
      // acceptQuote is idempotent (never-create-twice) — retry is safe.
      toast.error("Couldn't reach the server — check Bookings before retrying.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {compact ? (
        <Button size="sm" variant="outline" onClick={() => openDialog(true)} className="shrink-0">
          <CheckCircle2 className="size-4 text-success" strokeWidth={1.75} />
          Accept
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => openDialog(true)}
          className={cn("bg-mm-red text-white hover:bg-mm-red-deep", className)}
        >
          <CheckCircle2 className="size-4" strokeWidth={1.75} />
          {verb}
        </Button>
      )}

      <Dialog open={open} onOpenChange={openDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              {resolved ? verb : "Accept quote"}
            </DialogTitle>
            <DialogDescription>
              {commercial ? (
                <>
                  This confirms the booking on the client&apos;s account. No deposit is taken and{" "}
                  <strong>nothing is sent to the customer</strong> — you invoice it from{" "}
                  <Link href="/bookings" className="underline underline-offset-2">
                    Bookings
                  </Link>{" "}
                  once the job is done, due on their agreed terms.
                </>
              ) : (
                <>
                  This starts the booking: the customer gets an email with their deposit payment
                  link, the deposit invoice is raised in Zoho, and the lead sits in{" "}
                  <strong>Provisional</strong> — it confirms automatically the moment the deposit
                  lands. Track it in{" "}
                  <Link href="/bookings" className="underline underline-offset-2">
                    Bookings
                  </Link>
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Label htmlFor="agreed-price" className="mb-2 block">
              Agreed price
            </Label>
            <div className="flex h-12 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
              <span className="mr-1 text-base text-mist-400">£</span>
              <input
                id="agreed-price"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
              />
            </div>
            <p className="mt-1.5 text-xs text-mist-400">
              {commercial
                ? `Defaults to the quoted total (${gbp(Number(grandTotal ?? 0))}). Edit if the final figure differs — the completion invoice bills this number.`
                : `Defaults to the quoted total (${gbp(Number(grandTotal ?? 0))}). Edit if the final figure differs — the balance invoice later uses this number less the deposit.`}
            </p>

            {/* No deposit field on the commercial ladder — there is no deposit
                rung to fill in, and a field the server discards is worse than
                no field: it reads as a decision the office is making. */}
            {commercial ? null : (
              <>
                <Label htmlFor="accept-deposit" className="mt-4 mb-2 block">
                  Deposit to request
                </Label>
                <div className="flex h-12 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
                  <span className="mr-1 text-base text-mist-400">£</span>
                  <input
                    id="accept-deposit"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
                  />
                </div>
                <p className="mt-1.5 text-xs text-mist-400">
                  Standard is {gbp(depositAmount)} — raise it for bigger jobs if you want more down.
                </p>
              </>
            )}

            {policyFailed ? (
              <p className="mt-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger">
                Could not read this client&apos;s payment terms, so it is not safe to say what
                confirming would do. Reload and try again.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {/* Un-actionable until the ladder is known. A button that acted on
                an unresolved policy would be acting on a guess, and the guess
                that costs money is the one that emails a business client a
                deposit demand. */}
            <Button
              onClick={confirm}
              disabled={busy || !resolved}
              className="bg-mm-red text-white hover:bg-mm-red-deep"
            >
              {policyFailed ? null : busy || !resolved ? (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
              ) : (
                <CheckCircle2 className="size-4" strokeWidth={1.75} />
              )}
              {!resolved
                ? policyFailed
                  ? "Unavailable"
                  : "Checking terms…"
                : commercial
                  ? "Confirm booking"
                  : "Accept & request deposit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
