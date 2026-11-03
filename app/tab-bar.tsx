"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 11.5 12 3l9 8.5" />
      <path d="M5.5 10.5V20h13v-9.5" />
    </svg>
  );
}

function TodayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="5.5" width="16" height="15" rx="2" />
      <path d="M4 10.5h16M8.5 3v4M15.5 3v4" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

function ClosetIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export const TABS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/today", label: "Today", Icon: TodayIcon },
  { href: "/capture", label: "Add", Icon: AddIcon },
  { href: "/closet", label: "Closet", Icon: ClosetIcon },
] as const;

export function isActiveTab(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      // Solid contrasting surface in both modes: white/black light,
      // neutral-900/white dark. Never translucent, never page-black.
      className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-300 bg-white text-black md:hidden dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
    >
      <div className="mx-auto grid w-full max-w-2xl md:max-w-[960px] grid-cols-4 gap-1 px-2 pb-[env(safe-area-inset-bottom)] pt-1">
        {TABS.map((tab) => {
          const active = isActiveTab(tab.href, pathname);
          const Icon = tab.Icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-base ${
                active ? "bg-neutral-200 font-semibold dark:bg-neutral-800" : ""
              }`}
            >
              <Icon />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
