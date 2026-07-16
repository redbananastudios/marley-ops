const LINKS: { href: string; label: string }[] = [
  { href: "#how-a-job-flows", label: "How a job flows" },
  { href: "#office-guide", label: "Office guide" },
  { href: "#emails", label: "Emails the system sends" },
  { href: "#sending-emails", label: "Sending emails (or texts) from the panel" },
  { href: "#faq", label: "FAQ & gotchas" },
];

export function ManualToc() {
  return (
    <nav aria-label="Table of contents" className="rounded-lg border border-border bg-card p-5">
      <p className="eyebrow">On this page</p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href} className="focus-ring text-sm font-medium text-foreground underline decoration-mist-300 underline-offset-4 hover:text-mm-red hover:decoration-mm-red">
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
