import type { Metadata } from "next";
import "./globals.css";

import TabBar from "./tab-bar";
import TopNav from "./top-nav";

export const metadata: Metadata = {
  title: "Closet AI",
  description: "Outfits from the clothes you already own.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        {/* Bottom padding clears the fixed tab bar + iPhone home indicator. */}
        <div className="pb-28 md:pb-12">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
