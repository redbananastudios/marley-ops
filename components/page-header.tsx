import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export function PageHeader({
  eyebrow,
  title,
  backHref,
  backLabel,
  children,
}: {
  eyebrow: string;
  title: string;
  backHref?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {backHref ? (
          <Link
            href={backHref}
            className="focus-ring -ml-1 mb-1 inline-flex items-center gap-0.5 rounded-sm text-sm text-mist-400 transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            {backLabel ?? "Back"}
          </Link>
        ) : null}
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="font-display text-3xl text-foreground">{title}</h1>
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </header>
  );
}
