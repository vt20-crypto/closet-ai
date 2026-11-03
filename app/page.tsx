import Link from "next/link";

import { listItems } from "@/lib/closet";
import { tapeLabel } from "@/lib/labels";

import HomeWeather from "./home-weather";
import InstallTip from "./install-tip";
import MeButton from "./me-button";
import { Sticker, Tape } from "./sticker";
import { AddIcon, ClosetIcon } from "./tab-bar";

export const dynamic = "force-dynamic";

function altFor(item: { tags: { nickname?: string; primary_color: string; type: string } }): string {
  return `${tapeLabel(item.tags)} cutout`;
}

export default async function Home() {
  let recent: { id: string; cutoutUrl: string; alt: string; tape: string }[] = [];
  try {
    recent = [...(await listItems())]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        cutoutUrl: item.cutoutUrl,
        alt: altFor(item),
        tape: tapeLabel(item.tags),
      }));
  } catch {
    recent = [];
  }

  const tiles = [
    {
      href: "/capture",
      title: "Add clothes",
      caption: "Snap a photo to grow the closet",
      Icon: AddIcon,
    },
    {
      href: "/closet",
      title: "My closet",
      caption: "Everything you own",
      Icon: ClosetIcon,
    },
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 p-6 md:max-w-[960px]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-4xl leading-tight">Daily Edit</h1>
          <p className="text-lg text-(--text-muted)">What are we wearing today?</p>
          <HomeWeather />
        </div>
        <MeButton />
      </div>
      <Link
        href="/today"
        className="inline-flex min-h-14 items-center justify-center rounded-full bg-(--primary) px-6 text-xl font-semibold text-(--primary-text)"
      >
        Plan today&apos;s outfit
      </Link>
      <nav aria-label="Sections" className="grid grid-cols-2 gap-4">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="flex min-h-36 flex-col justify-between gap-6 rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 shadow-[0_10px_24px_var(--shadow)]"
          >
            <tile.Icon />
            <span>
              <span className="font-display block text-2xl leading-snug">{tile.title}</span>
              <span className="block text-base text-(--text-muted)">{tile.caption}</span>
            </span>
          </Link>
        ))}
      </nav>
      <section aria-label="Your wardrobe" className="flex flex-col gap-3">
        <h2 className="font-display text-3xl">Your wardrobe</h2>
        {recent.length > 0 ? (
          <ul className="flex snap-x gap-4 overflow-x-auto pb-4">
            {recent.map((item) => (
              <li key={item.id} className="w-32 shrink-0 snap-start">
                <Link
                  href="/closet"
                  aria-label={`${item.tape}, view in closet`}
                  className="flex flex-col items-center rounded-[20px] border border-(--border-soft) bg-(--surface-2) p-3 shadow-[0_10px_24px_var(--shadow)]"
                >
                  <span className="flex aspect-[3/4] w-full items-center justify-center">
                    <Sticker src={item.cutoutUrl} alt={item.alt} seedId={item.id} rich />
                  </span>
                  <span className="mt-1 max-w-full">
                    <Tape label={item.tape} seedId={item.id} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Link
            href="/capture"
            className="inline-block rounded-[20px] border border-(--border-soft) bg-(--surface) p-5 text-lg shadow-[0_10px_24px_var(--shadow)]"
          >
            Add your first piece
          </Link>
        )}
      </section>
      <InstallTip />
    </main>
  );
}
