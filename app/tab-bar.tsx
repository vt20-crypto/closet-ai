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

export function AddIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

export function ClosetIcon() {
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
  { href: "/style", label: "Style", Icon: TodayIcon },
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
      // Dark espresso in BOTH modes; cream labels, tomato active tab. The
      // ::after slab extends the background below the bar so nothing of the
      // page shows through during scroll or rubber-band bounce.
      className="fixed inset-x-0 bottom-0 z-50 border-t border-(--tabbar-bg) bg-(--tabbar-bg) pb-[env(safe-area-inset-bottom)] text-(--tabbar-text) after:absolute after:top-full after:right-0 after:left-0 after:h-[120px] after:bg-(--tabbar-bg) after:content-[''] md:hidden"
    >
      <div className="mx-auto grid w-full max-w-2xl grid-cols-4 gap-1 px-2 pt-1 md:max-w-[960px]">
        {TABS.map((tab) => {
          const active = isActiveTab(tab.href, pathname);
          const Icon = tab.Icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-base ${
                active ? "font-bold text-(--tabbar-active)" : ""
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
