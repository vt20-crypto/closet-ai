import Link from "next/link";

import HealthStatus from "./health-status";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl md:max-w-[960px] flex-col gap-6 p-6">
      <h1 className="text-4xl font-bold">Closet AI</h1>
      <p className="text-lg">Outfits from the clothes you already own.</p>
      <Link
        href="/capture"
        className="inline-block min-h-14 rounded-2xl bg-black px-6 py-4 text-center text-xl font-semibold text-white dark:bg-white dark:text-black"
      >
        Add clothes
      </Link>
      <Link
        href="/closet"
        className="inline-block min-h-14 rounded-2xl border border-neutral-400 px-6 py-4 text-center text-xl font-semibold"
      >
        View closet
      </Link>
      <Link
        href="/today"
        className="inline-block min-h-14 rounded-2xl border border-neutral-400 px-6 py-4 text-center text-xl font-semibold"
      >
        Today&apos;s outfits
      </Link>
      <HealthStatus />
    </main>
  );
}
