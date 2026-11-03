// Contrast gate for the theme tokens in app/globals.css.
// Text pairs must be >= 4.5:1, border/focus pairs >= 3:1 (WCAG AA).
// Run: node scripts/check-contrast.mjs (exit 1 on any failure).

const TOKENS = {
  light: {
    background: "#ffffff",
    surface: "#ffffff",
    "surface-2": "#f5f5f5",
    text: "#000000",
    "text-muted": "#525252",
    border: "#737373",
    primary: "#000000",
    "primary-text": "#ffffff",
    danger: "#b91c1c",
    "disabled-bg": "#e5e5e5",
    "disabled-text": "#525252",
    "focus-ring": "#2563eb",
  },
  dark: {
    background: "#000000",
    surface: "#171717",
    "surface-2": "#262626",
    text: "#ffffff",
    "text-muted": "#d4d4d4",
    border: "#6b6b6b",
    primary: "#ffffff",
    "primary-text": "#000000",
    danger: "#fca5a5",
    "disabled-bg": "#262626",
    "disabled-text": "#d4d4d4",
    "focus-ring": "#93c5fd",
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
  ["disabled-text", "disabled-bg"],
  ["danger", "background"],
  ["danger", "surface"],
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
