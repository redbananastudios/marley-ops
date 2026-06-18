import { cn } from "@/lib/utils";

/** The 7 manual funnel statuses, with the design's colour map (one accent — red — reserved). */
const STATUS: Record<string, { label: string; className: string }> = {
  website_enquiry: { label: "Enquiry", className: "bg-mist-100 text-charcoal" },
  survey_booked: { label: "Survey booked", className: "bg-mist-100 text-mist-500" },
  quoted: { label: "Quoted", className: "bg-mm-red-tint text-mm-red-deep" },
  provisional: { label: "Provisional", className: "bg-[#F3EEFB] text-[#6D28D9]" },
  confirmed: { label: "Confirmed", className: "bg-mm-red text-white" },
  completed: { label: "Completed", className: "bg-success-bg text-success" },
  declined: { label: "Declined", className: "bg-mist-50 text-mist-400" },
};

export function LeadStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, className: "bg-mist-100 text-charcoal" };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

export const LEAD_STATUSES = Object.keys(STATUS) as Array<keyof typeof STATUS>;
export const LEAD_STATUS_META = STATUS;
