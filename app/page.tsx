import Link from "next/link";

import { listItems } from "@/lib/closet";
import { tapeLabel } from "@/lib/labels";

import HealthStatus from "./health-status";
import HomeWeather from "./home-weather";
import { Sticker, Tape } from "./sticker";
import ThemeSwitch from "./theme-switch";

export const dynamic = "force-dynamic";

function altFor(item: { tags: { nickname?: string; primary_color: string; type: string } }): string {
  return `${tapeLabel(item.tags)} cutout`;
}

export default async function Home() {
  let stickers: { id: string; cutoutUrl: string; alt: string; tape: string }[] = [];
  try {
    stickers = (await listItems())
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        cutoutUrl: item.cutoutUrl,
        alt: altFor(item),
        tape: tapeLabel(item.tags),
      }));
  } catch {
    stickers = [];
  }

  const tiles = [
    { href: "/today", title: "Today's outfit", caption: "Picked for your weather", sticker: stickers[0] },
    { href: "/capture", title: "Add clothes", caption: "Snap a photo to grow the closet", sticker: stickers[1] },
    { href: "/closet", title: "My closet", caption: "Everything you own", sticker: stickers[2] },
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-4xl leading-tight">Daily Edit</h1>
          <p className="text-lg text-(--text-muted)">What are we wearing today?</p>
          <HomeWeather />
        </div>
        <span
          role="img"
          aria-label="Profile avatar (placeholder — your stylized avatar will live here)"
          className="font-display flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-(--border-soft) bg-(--surface-2) text-2xl"
        >
          C
        </span>
      </div>
      <Link
        href="/today"
        className="inline-flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-xl font-semibold text-(--primary-text)"
      >
        + Plan outfit
      </Link>
      <nav aria-label="Sections" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="relative flex min-h-36 flex-col justify-between gap-6 overflow-visible rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
          >
            <span className="font-display text-2xl leading-snug">{tile.title}</span>
            <span className="text-base text-(--text-muted)">{tile.caption}</span>
            {tile.sticker && (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-2 -bottom-4 flex w-24 flex-col items-center"
              >
                <Sticker src={tile.sticker.cutoutUrl} alt="" seedId={tile.sticker.id} rich />
                <span className="-mt-2">
                  <Tape label={tile.sticker.tape} seedId={tile.sticker.id} />
                </span>
              </span>
            )}
          </Link>
        ))}
      </nav>
      <ThemeSwitch />
      <HealthStatus />
    </main>
  );
}
