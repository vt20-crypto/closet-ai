import { Caveat, DM_Sans, Playfair_Display } from "next/font/google";

/**
 * Scrapbook type system. next/font self-hosts these at build time, so the
 * browser never requests Google Fonts at runtime. All three are SIL OFL 1.1
 * (see README "Third-party code").
 */
export const playfair = Playfair_Display({
  weight: "700",
  subsets: ["latin"],
  variable: "--font-playfair",
});

export const dmSans = DM_Sans({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-dmsans",
});

export const caveat = Caveat({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--font-caveat",
});
