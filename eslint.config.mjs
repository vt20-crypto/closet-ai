// Flat-native ESLint config (no FlatCompat).
//
// The stock create-next-app config loads "next/core-web-vitals" through
// FlatCompat, which crashes in this repo's install with
// "TypeError: Converting circular structure to JSON" (the legacy translation
// chokes on eslint-plugin-react's config objects; fails on eslint 9.32 and
// 9.39 alike). This wires the same rule sets from each plugin's flat entry
// point instead. Dropped vs stock: eslint-plugin-jsx-a11y and
// eslint-plugin-import (installed versions ship legacy configs only, which is
// exactly the broken path); revisit if they gain flat entry points.

import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const eslintConfig = [
  { ignores: [".next/**", "out/**", "build/**"] },
  ...tseslint.configs.recommended,
  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat["jsx-runtime"],
  hooksPlugin.configs.flat.recommended,
  nextPlugin.configs["core-web-vitals"],
  nextPlugin.configs["recommended"],
];

export default eslintConfig;
