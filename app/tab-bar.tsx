"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home" },
  { href: "/today", label: "Today" },
  { href: "/capture", label: "Add" },
  { href: "/closet", label: "Closet" },
] as const;

function isActiveTab(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-300 bg-white dark:border-neutral-700 dark:bg-black"
    >
      <div className="mx-auto grid w-full max-w-2xl grid-cols-4 pb-[env(safe-area-inset-bottom)]">
        {TABS.map((tab) => {
          const active = isActiveTab(tab.href, pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-16 flex-col items-center justify-center text-lg ${
                active ? "font-semibold" : ""
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
