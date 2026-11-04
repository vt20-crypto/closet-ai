"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { TABS, isActiveTab } from "./tab-bar";
import MeButton from "./me-button";

/**
 * Top navigation for iPad and laptop (md+, i.e. ≥ 768px). Phones keep the
 * bottom tab bar. Same destinations, active state, and light/dark surfaces.
 */
export default function TopNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-50 hidden border-b border-(--border-soft) bg-(--surface) text-(--text) md:block">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-2 md:max-w-[960px]">
        <Link href="/" className="font-display min-h-11 py-2 text-2xl">
          Closet Pod
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <MeButton />
          <nav aria-label="Primary" className="flex gap-1">
            {TABS.map((tab) => {
              const active = isActiveTab(tab.href, pathname);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-lg ${
                    active ? "bg-(--primary) font-semibold text-(--primary-text)" : ""
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}
