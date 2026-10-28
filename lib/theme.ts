"use client";

import { useCallback, useEffect, useState } from "react";

// Light/dark preference. "system" leaves html[data-theme] unset so the prefers-color-scheme
// rules in app/globals.css decide; the inline script in app/layout.tsx re-applies a saved choice
// before first paint. Keep THEME_KEY in sync with that script.
export type ThemePref = "system" | "light" | "dark";

const THEME_KEY = "xbookmarks:theme";

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") setPrefState(stored);
    } catch {
      // storage unavailable: stay on system
    }
  }, []);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    apply(next);
    try {
      if (next === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }, []);

  return { pref, setPref };
}
