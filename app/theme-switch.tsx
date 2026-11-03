"use client";

import { useSyncExternalStore } from "react";

import { applyThemeChoice, themeChoices, type ThemeChoice } from "@/lib/theme";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("theme-change", onChange);
  return () => window.removeEventListener("theme-change", onChange);
}

function getSnapshot(): ThemeChoice {
  return document.documentElement.dataset.theme === "light" ||
    document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : "auto";
}

function getServerSnapshot(): ThemeChoice {
  return "auto";
}

/**
 * Auto / Light / Dark switch. The pre-paint head script owns the initial
 * value; this control reads it live and writes through to <html> +
 * localStorage.
 */
export default function ThemeSwitch() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function select(next: ThemeChoice) {
    applyThemeChoice(next);
    window.dispatchEvent(new Event("theme-change"));
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-1">
      {themeChoices().map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={choice === option}
          onClick={() => select(option)}
          className={`min-h-11 rounded-full px-4 text-base capitalize ${
            choice === option ? "bg-(--surface-2) font-semibold" : ""
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
