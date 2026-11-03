import type { Metadata, Viewport } from "next";
import "./globals.css";

import { caveat, dmSans, playfair } from "./fonts";
import TabBar from "./tab-bar";
import TopNav from "./top-nav";

export const metadata: Metadata = {
  title: "Closet AI",
  description: "Outfits from the clothes you already own.",
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FBF6EC" },
    { media: "(prefers-color-scheme: dark)", color: "#17120F" },
  ],
};

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("closet-ai-theme");document.documentElement.dataset.theme=(t==="light"||t==="dark")?t:"auto";var e=t==="light"||t==="dark"?t:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}m.content=e==="dark"?"#17120F":"#FBF6EC"}catch(e){document.documentElement.dataset.theme="auto"}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The head script sets data-theme pre-paint, so hydration must not warn
    // about the attribute it adds.
    <html
      lang="en"
      suppressHydrationWarning
      className={`bg-(--background) ${playfair.variable} ${dmSans.variable} ${caveat.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-(--background) text-(--text)">
        <TopNav />
        {/* Bottom padding clears the fixed tab bar + iPhone home indicator. */}
        <div className="pb-[calc(env(safe-area-inset-bottom)+80px)] md:pb-12">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
