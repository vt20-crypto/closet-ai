import type { Metadata } from "next";
import "./globals.css";

import TabBar from "./tab-bar";

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
        {/* Bottom padding clears the fixed tab bar + iPhone home indicator. */}
        <div className="pb-28">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
