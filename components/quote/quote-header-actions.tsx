"use client";

/**
 * Quote-header action row — ONE tidy, responsive row for every quote state.
 *
 * Grammar (ui-ux standards): exactly one brand-red primary per state, every
 * other action shares one 44px outline/ghost secondary grammar, and the
 * low-frequency + destructive actions collapse into a "⋯ More" overflow menu so
 * the header never wraps raggedly. Meta (status pill, Emailed ×N, Agreed £,
 * deposit) lives up by the eyebrow, NOT in here.
 *
 * Primary per state:
 *   draft   → Accept quote        (the staff conversion; wizard's own Send lives in the body)
 *   sent    → Accept quote
 *   accepted→ Open in Bookings    (the page's key next action)
 *   rejected/superseded → none    (dead states get no red primary)
 * Secondaries (visible): View lead, Cubic survey, Edit quote (read-only view only).
 * Overflow (⋯):  Re-send quote email, Reject quote, Delete quote.
 *
 * This is presentation only — every handler, dialog and server action is the
 * exact same one the header used before; the dialogs are just driven in
 * controlled mode so the overflow-menu items can open them.
 */

import { useState } from "react";
import Link from "next/link";
import { Boxes, ClipboardCheck, Mail, MoreHorizontal, Pencil, ThumbsDown, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LeadOption } from "@/components/schedule/appointment-dialog";
import type { QuoteFormValues } from "@/lib/quote/form-types";
import type { Brand } from "@/lib/brand";
import type { PricingConfig } from "@/lib/quote/pricing";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
import { RejectQuoteButton } from "@/components/quote/reject-quote-button";
import { DeleteQuoteButton } from "@/components/quote/delete-quote-button";
import { ResendQuoteButton } from "@/components/quote/resend-quote-button";
import { ViewLeadDialog } from "@/components/quote/view-lead-dialog";

/** One secondary grammar — 44px, hairline outline, quiet. On phones each action
 *  takes ~half the row (two per line; a lone trailing item grows to full width);
 *  from sm up they sit at their natural width in one flex row. */
const SECONDARY =
  "focus-ring inline-flex h-11 min-w-0 grow basis-[calc(50%_-_0.25rem)] items-center justify-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:grow-0 sm:basis-auto";

export interface QuoteHeaderActionsProps {
  quoteId: string;
  quoteRef: string;
  status: string;
  grandTotal: number;
  depositAmount: number;
  /** Read-only view is showing → offer Edit as a secondary. Wizard states hide it. */
  readOnly: boolean;
  editHref: string;
  leadId: string | null;
  clientId: string | null;
  /** Lead context for the View-lead dialog (null when the quote has no lead). */
  lead: LeadOption | null;
  leadStatus: string | null;
  leadEmail: string | null;
  /** Re-send wiring — identical to the original send path. */
  values: QuoteFormValues;
  pricing: PricingConfig;
  estimatorName: string | null;
  vatNumber?: string;
  acceptUrl?: string;
  /** The quote's brand row — drives the send dialog's subject and chrome
   *  (multi-brand PRD §3.5); absent/marley renders today's exact email. */
  brand?: Brand | null;
}

export function QuoteHeaderActions({
  quoteId,
  quoteRef,
  status,
  grandTotal,
  depositAmount,
  readOnly,
  editHref,
  leadId,
  clientId,
  lead,
  leadStatus,
  leadEmail,
  values,
  pricing,
  estimatorName,
  vatNumber,
  acceptUrl,
  brand,
}: QuoteHeaderActionsProps) {
  const [resendOpen, setResendOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [viewLeadOpen, setViewLeadOpen] = useState(false);

  const isLive = status === "draft" || status === "sent";
  const canResend = status === "sent" || status === "accepted";
  const canReject = status === "sent";

  // Defer opening a dialog until the menu has finished closing, so Radix's
  // focus-return and the dialog's focus-trap don't fight over the same tick.
  const openLater = (fn: () => void) => window.setTimeout(fn, 0);

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
      {/* PRIMARY — one per state, brand red, full-width on mobile */}
      {isLive ? (
        <AcceptQuoteButton
          quoteId={quoteId}
          grandTotal={grandTotal}
          status={status}
          depositAmount={depositAmount}
          className="h-11 w-full sm:w-auto"
        />
      ) : status === "accepted" ? (
        <Link
          href="/bookings"
          className="focus-ring inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-mm-red px-4 text-sm font-semibold text-white transition-colors hover:bg-mm-red-deep sm:w-auto"
        >
          <ClipboardCheck className="size-4" strokeWidth={2} />
          Open in Bookings
        </Link>
      ) : null}

      {/* SECONDARIES + overflow — two-per-row on phones, one flex row from sm up.
          Record actions share one grammar; the "⋯ More" menu holds the
          low-frequency + destructive actions so the row never wraps raggedly. */}
      <div className="flex flex-wrap gap-2 sm:items-center">
        {lead ? (
          <button type="button" onClick={() => setViewLeadOpen(true)} className={SECONDARY}>
            <Users className="size-4" strokeWidth={1.75} />
            View lead
          </button>
        ) : null}
        {leadId ? (
          <Link href={`/leads/${leadId}/cubic`} className={SECONDARY}>
            <Boxes className="size-4" strokeWidth={1.75} />
            Cubic survey
          </Link>
        ) : null}
        {readOnly ? (
          <Link href={editHref} className={SECONDARY}>
            <Pencil className="size-4" strokeWidth={1.75} />
            Edit quote
          </Link>
        ) : null}

        {/* Overflow — Delete is always available, so the menu always renders.
            Labelled "More" on phones, a 44px icon square from sm up. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              className={cn(SECONDARY, "sm:w-11 sm:px-0")}
            >
              <MoreHorizontal className="size-4" strokeWidth={1.75} />
              <span className="sm:hidden">More</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canResend ? (
              <DropdownMenuItem onSelect={() => openLater(() => setResendOpen(true))}>
                <Mail strokeWidth={1.75} />
                Re-send quote email
              </DropdownMenuItem>
            ) : null}
            {canReject ? (
              <DropdownMenuItem onSelect={() => openLater(() => setRejectOpen(true))}>
                <ThumbsDown strokeWidth={1.75} />
                Reject quote
              </DropdownMenuItem>
            ) : null}
            {canResend || canReject ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => openLater(() => setDeleteOpen(true))}>
              <Trash2 strokeWidth={1.75} />
              Delete quote
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Controlled dialogs — render nothing until opened (portalled), so they
          never add a stray flex item to the row. */}
      {lead ? (
        <ViewLeadDialog lead={lead} status={leadStatus} open={viewLeadOpen} onOpenChange={setViewLeadOpen} />
      ) : null}
      {canResend ? (
        <ResendQuoteButton
          quoteId={quoteId}
          quoteRef={quoteRef}
          values={values}
          pricing={pricing}
          leadId={leadId}
          clientId={clientId}
          leadEmail={leadEmail}
          estimatorName={estimatorName}
          vatNumber={vatNumber}
          depositAmount={depositAmount}
          acceptUrl={acceptUrl}
          brand={brand}
          open={resendOpen}
          onOpenChange={setResendOpen}
        />
      ) : null}
      {canReject ? (
        <RejectQuoteButton quoteId={quoteId} status={status} open={rejectOpen} onOpenChange={setRejectOpen} />
      ) : null}
      <DeleteQuoteButton
        quoteId={quoteId}
        status={status}
        quoteRef={quoteRef}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}
