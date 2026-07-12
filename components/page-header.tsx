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
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
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
        <h1 className="font-display text-3xl font-semibold tracking-[-0.035em] text-foreground md:text-4xl">{title}</h1>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}
