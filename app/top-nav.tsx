"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { TABS, isActiveTab } from "./tab-bar";

/**
 * Top navigation for iPad and laptop (md+, i.e. ≥ 768px). Phones keep the
 * bottom tab bar. Same destinations, active state, and light/dark surfaces.
 */
export default function TopNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-50 hidden border-b border-neutral-300 bg-white text-black md:block dark:border-neutral-700 dark:bg-neutral-900 dark:text-white">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-6 py-2 md:max-w-[960px]">
        <Link href="/" className="min-h-11 py-2 text-xl font-bold">
          Closet AI
        </Link>
        <nav aria-label="Primary" className="flex gap-1">
          {TABS.map((tab) => {
            const active = isActiveTab(tab.href, pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-full px-4 text-lg ${
                  active ? "bg-neutral-200 font-semibold dark:bg-neutral-800" : ""
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
