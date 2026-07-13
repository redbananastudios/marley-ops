import type { LucideIcon } from "lucide-react";
import { Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * THE single source of truth for how customer contact actions look across the
 * whole panel — call, WhatsApp, email, directions. Before this they were styled
 * ad-hoc per screen (pink phone here, blue phone there, green WhatsApp), so the
 * leads page, pipeline board and lead detail all disagreed.
 *
 * Everything is neutral grey with a hover so red stays rare (the brand rule).
 * To restyle every contact action in the app, change `contactActionClass` /
 * `CONTACT_ICON` here — nothing else.
 */

export type ContactKind = "call" | "whatsapp" | "email" | "directions";

export const CONTACT_ICON: Record<ContactKind, LucideIcon> = {
  call: Phone,
  whatsapp: MessageCircle,
  email: Mail,
  directions: MapPin,
};

const CONTACT_LABEL: Record<ContactKind, string> = {
  call: "Call",
  whatsapp: "WhatsApp",
  email: "Email",
  directions: "Directions",
};

/**
 * Shared class for a contact action.
 *  - "icon":   a square icon-only tap target (dense rows, cards, the board)
 *  - "button": icon + label with a hairline border (action bars)
 */
export function contactActionClass(variant: "icon" | "button" = "icon", className?: string) {
  return cn(
    "focus-ring inline-flex items-center justify-center gap-1.5 rounded-md text-mist-500 transition-colors hover:bg-muted hover:text-foreground",
    variant === "icon" ? "size-9" : "min-h-11 border border-input bg-card px-3.5 text-sm font-medium",
    className,
  );
}

/** A ready-made contact link. External kinds (WhatsApp, Directions) open a new tab. */
export function ContactAction({
  kind,
  href,
  variant = "icon",
  label,
  className,
}: {
  kind: ContactKind;
  href: string;
  variant?: "icon" | "button";
  /** override the default label text (button variant only), e.g. "Call customer" */
  label?: string;
  className?: string;
}) {
  const Icon = CONTACT_ICON[kind];
  const text = label ?? CONTACT_LABEL[kind];
  const external = kind === "whatsapp" || kind === "directions";
  return (
    <a
      href={href}
      aria-label={text}
      title={text}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={contactActionClass(variant, className)}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      {variant === "button" ? text : null}
    </a>
  );
}
