export type ThemeChoice = "auto" | "light" | "dark";

const STORAGE_KEY = "closet-ai-theme";

const CHOICES: ThemeChoice[] = ["auto", "light", "dark"];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "auto" || value === "light" || value === "dark";
}

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeChoice(saved)) return saved;
  } catch {
    // Private mode: fall back to auto.
  }
  return "auto";
}

export function applyThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private mode: the choice simply isn't remembered.
  }
  document.documentElement.dataset.theme = choice;
  // Keep the iOS status bar / overscroll color in sync with the theme.
  const effective =
    choice === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", effective === "dark" ? "#17120F" : "#FBF6EC");
}

export function themeChoices(): ThemeChoice[] {
  return CHOICES;
}
