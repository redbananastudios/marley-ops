"use client";

/**
 * Mobile / tablet navigation. The desktop sidebar is hidden below md, so this
 * supplies a sticky top bar (wordmark + hamburger) and a left slide-over drawer
 * that reuses the exact same nav list + footer as the sidebar. md+ renders
 * nothing (the sidebar takes over).
 */

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { SidebarNavList, NavFooter } from "@/components/app-sidebar";

export function MobileNav({ profile }: { profile: { full_name: string; role: string } }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background px-4 md:hidden">
        <span className="font-display text-lg text-foreground">
          Marley <span className="text-mm-red">Ops</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="focus-ring -mr-2 flex size-11 items-center justify-center rounded-md text-foreground"
        >
          <Menu className="size-6" strokeWidth={1.75} />
        </button>
      </header>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85%] flex-col bg-sidebar shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden"
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="font-display text-lg text-foreground">
                Marley <span className="text-mm-red">Ops</span>
              </span>
              <DialogPrimitive.Close
                aria-label="Close menu"
                className="focus-ring -mr-2 flex size-11 items-center justify-center rounded-md text-mist-400 hover:text-foreground"
              >
                <X className="size-5" strokeWidth={1.75} />
              </DialogPrimitive.Close>
            </div>

            <nav className="flex-1 overflow-y-auto px-3 py-4">
              <SidebarNavList pathname={pathname} onNavigate={() => setOpen(false)} />
            </nav>

            <NavFooter profile={profile} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
