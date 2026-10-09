// Per-device appearance preferences (theme, reading size, reading font). Stored in localStorage
// because they are about this screen, not the account; failures fall back to defaults.
import { useSyncExternalStore } from 'react';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  text: 's' | 'm' | 'l' | 'xl';
  readFont: 'serif' | 'sans';
}

const KEY = 'relay.prefs';
const DEFAULTS: Prefs = { theme: 'system', text: 'm', readFont: 'serif' };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export function applyPrefs(p: Prefs = prefs) {
  const root = document.documentElement;
  if (p.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  root.dataset.text = p.text;
  root.dataset.readfont = p.readFont;
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
  applyPrefs();
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => prefs,
  );
}
