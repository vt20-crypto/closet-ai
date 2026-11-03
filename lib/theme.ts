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
}

export function themeChoices(): ThemeChoice[] {
  return CHOICES;
}
