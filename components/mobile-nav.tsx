"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, Search, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { QuickCreate } from "@/components/quick-create";
import { openGlobalSearch } from "@/components/search/open-search";
import { BrandMark, NavFooter, SidebarNavList } from "@/components/app-sidebar";

export function MobileNav({ profile }: { profile: { full_name: string; role: string } }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 xl:hidden">
        <BrandMark compact />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={openGlobalSearch}
            aria-label="Search leads, clients and quotes"
            className="focus-ring flex size-11 items-center justify-center rounded-md text-white/85 hover:bg-white/[0.06]"
          >
            <Search className="size-5" strokeWidth={1.75} />
          </button>
          <QuickCreate compact />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="focus-ring flex size-11 items-center justify-center rounded-md text-white/85 hover:bg-white/[0.06]"
          >
            <Menu className="size-6" strokeWidth={1.65} />
          </button>
        </div>
      </header>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 xl:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-80 max-w-[88%] flex-col border-r border-white/8 bg-sidebar shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left xl:hidden"
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex h-16 items-center justify-between px-4">
              <BrandMark compact onNavigate={() => setOpen(false)} />
              <DialogPrimitive.Close
                aria-label="Close menu"
                className="focus-ring flex size-11 items-center justify-center rounded-md text-white/55 hover:bg-white/[0.06] hover:text-white"
              >
                <X className="size-5" strokeWidth={1.65} />
              </DialogPrimitive.Close>
            </div>

            <div className="px-3 pb-1 pt-1">
              <QuickCreate className="w-full" />
            </div>
            <nav className="nav-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4">
              <SidebarNavList pathname={pathname} role={profile.role} onNavigate={() => setOpen(false)} />
            </nav>
            <NavFooter profile={profile} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
