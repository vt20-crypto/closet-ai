import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
