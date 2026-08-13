"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CartModifier = {
  id: number;
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
};

export type CartLine = {
  /** Stable key: item + sorted modifier ids + notes. Same config merges. */
  key: string;
  itemId: number;
  itemName: string;
  /** Base + modifier deltas, per unit (display only; server re-prices). */
  unitPriceCents: number;
  quantity: number;
  modifiers: CartModifier[];
  notes?: string;
};

type CartContextValue = {
  lines: CartLine[];
  itemCount: number;
  subtotalCents: number;
  addLine: (line: Omit<CartLine, "key">) => void;
  updateQuantity: (key: string, quantity: number) => void;
  removeLine: (key: string) => void;
  clear: () => void;
  /** True once the cart has hydrated from localStorage. */
  ready: boolean;
};

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "minks-cart-v1";

function lineKey(line: Omit<CartLine, "key">): string {
  const mods = [...line.modifiers.map((m) => m.id)].sort((a, b) => a - b);
  return `${line.itemId}:${mods.join(",")}:${line.notes ?? ""}`;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);

  // Hydrate from localStorage after mount — deliberate setState-in-effect so
  // server and first client render agree (empty cart), avoiding hydration
  // mismatches.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (Array.isArray(parsed)) setLines(parsed);
      }
    } catch {
      // corrupted cart — start fresh
    }
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // storage unavailable (private mode) — cart is session-only
    }
  }, [lines]);

  const addLine = useCallback((line: Omit<CartLine, "key">) => {
    const key = lineKey(line);
    setLines((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l,
        );
      }
      return [...prev, { ...line, key }];
    });
  }, []);

  const updateQuantity = useCallback((key: string, quantity: number) => {
    setLines((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity } : l)),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartContextValue>(() => {
    const itemCount = lines.reduce((n, l) => n + l.quantity, 0);
    const subtotalCents = lines.reduce(
      (n, l) => n + l.unitPriceCents * l.quantity,
      0,
    );
    return {
      lines,
      itemCount,
      subtotalCents,
      addLine,
      updateQuantity,
      removeLine,
      clear,
      ready,
    };
  }, [lines, ready, addLine, updateQuantity, removeLine, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
