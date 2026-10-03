/**
 * Per-device preferences in localStorage: read after hydration, written on
 * every change. Client only.
 */
import { useCallback, useEffect, useState } from "react";

export function usePersistentPrefs<P extends object>(
  key: string,
  defaults: P,
  sanitize: (stored: P) => P = (p) => p,
): [P, (patch: Partial<P>) => void] {
  const [prefs, setPrefs] = useState(defaults);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
      if (stored) setPrefs(sanitize({ ...defaults, ...JSON.parse(stored) }));
    } catch {
      // Unreadable or blocked storage: keep the defaults.
    }
    // Read once per mount; later changes to defaults don't reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (patch: Partial<P>) =>
      setPrefs((p) => {
        const next = { ...p, ...patch };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Private mode or storage full: preferences just won't persist.
        }
        return next;
      }),
    [key],
  );

  return [prefs, update];
}
