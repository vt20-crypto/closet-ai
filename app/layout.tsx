import type { Metadata } from "next";
import "./globals.css";

import { caveat, dmSans, playfair } from "./fonts";
import TabBar from "./tab-bar";
import TopNav from "./top-nav";

export const metadata: Metadata = {
  title: "Closet AI",
  description: "Outfits from the clothes you already own.",
};

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("closet-ai-theme");document.documentElement.dataset.theme=(t==="light"||t==="dark")?t:"auto"}catch(e){document.documentElement.dataset.theme="auto"}})();`;

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
      className={`${playfair.variable} ${dmSans.variable} ${caveat.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-(--background) text-(--text)">
        <TopNav />
        {/* Bottom padding clears the fixed tab bar + iPhone home indicator. */}
        <div className="pb-28 md:pb-12">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
