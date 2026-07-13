import { MapPin, Phone } from "lucide-react";

/**
 * Sticky bottom action bar for the crew job sheet — the three things a mover
 * reaches for one-handed in the van cab: navigate to the job, call the
 * customer, and the next job-state action (Complete). Server component: the
 * primary slot receives the existing client CompleteJobButton (its dialog opens
 * from wherever it renders). Fixed to the bottom with safe-area padding; the
 * page reserves matching bottom padding so nothing hides behind it.
 */
export function CrewActionBar({
  phone,
  firstName,
  directionsTo,
  children,
}: {
  phone: string | null;
  firstName: string;
  directionsTo: string | null;
  children?: React.ReactNode;
}) {
  const tel = phone?.replace(/\s+/g, "");
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-2xl items-stretch gap-2 px-4 py-3">
        {directionsTo ? (
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(directionsTo)}`}
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <MapPin className="size-4 shrink-0" strokeWidth={1.75} />
            Directions
          </a>
        ) : null}
        {tel ? (
          <a
            href={`tel:${tel}`}
            className="focus-ring inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Phone className="size-4 shrink-0" strokeWidth={1.75} />
            Call {firstName}
          </a>
        ) : null}
        {children ? <div className="flex-[1.4]">{children}</div> : null}
      </div>
    </div>
  );
}
