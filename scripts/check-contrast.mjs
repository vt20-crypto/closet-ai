// Contrast gate for the theme tokens in app/globals.css.
// Text pairs must be >= 4.5:1, border/focus pairs >= 3:1 (WCAG AA).
// --border-soft is decorative only (card edges, tile seams) and is NOT
// gated; every interactive control border uses --border and IS gated.
// Run: node scripts/check-contrast.mjs (exit 1 on any failure).

const TOKENS = {
  light: {
    background: "#fbf6ec",
    surface: "#ffffff",
    "surface-2": "#f3ebdd",
    text: "#231a17",
    "text-muted": "#5e524b",
    border: "#8a7b70",
    primary: "#c93a22",
    "primary-text": "#ffffff",
    pop: "#ffd84d",
    "pop-ink": "#231a17",
    danger: "#b3261e",
    "disabled-bg": "#e6dccb",
    "disabled-text": "#5e524b",
    "focus-ring": "#7c2d12",
    "tabbar-bg": "#231a17",
    "tabbar-text": "#f6eee3",
    "tabbar-active": "#ff7a5c",
  },
  dark: {
    background: "#17120f",
    surface: "#241d19",
    "surface-2": "#2e2520",
    text: "#f6eee3",
    "text-muted": "#cdbfb2",
    border: "#9c8b7e",
    primary: "#ff7a5c",
    "primary-text": "#17120f",
    pop: "#ffd84d",
    "pop-ink": "#231a17",
    danger: "#ff9d94",
    "disabled-bg": "#2e2520",
    "disabled-text": "#cdbfb2",
    "focus-ring": "#ffd0bc",
    "tabbar-bg": "#231a17",
    "tabbar-text": "#f6eee3",
    "tabbar-active": "#ff7a5c",
  },
};

// [foreground, background-as-used, minRatio]
const TEXT_PAIRS = [
  ["text", "background"],
  ["text", "surface"],
  ["text", "surface-2"],
  ["text-muted", "background"],
  ["text-muted", "surface"],
  ["text-muted", "surface-2"],
  ["primary-text", "primary"],
  ["pop-ink", "pop"],
  ["disabled-text", "disabled-bg"],
  ["danger", "background"],
  ["danger", "surface"],
  ["tabbar-text", "tabbar-bg"],
  ["tabbar-active", "tabbar-bg"],
];
const NON_TEXT_PAIRS = [
  ["border", "background"],
  ["border", "surface"],
  ["focus-ring", "background"],
  ["focus-ring", "surface"],
];

function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
for (const [mode, tokens] of Object.entries(TOKENS)) {
  for (const [fg, bg] of TEXT_PAIRS) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= 4.5;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${mode} text ${fg} on ${bg}: ${r.toFixed(2)}:1 (min 4.5)`);
  }
  for (const [fg, bg] of NON_TEXT_PAIRS) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= 3.0;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${mode} ui ${fg} on ${bg}: ${r.toFixed(2)}:1 (min 3.0)`);
  }
}
if (failures > 0) {
  console.error(`\n${failures} contrast check(s) failed.`);
  process.exit(1);
}
console.log("\nAll contrast checks passed.");
