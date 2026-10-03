"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { normalizeCode } from "@/lib/promo-code";

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
  /** Codes as typed, kept with the cart so edits and refreshes never drop them. */
  promoCodes: string[];
  addPromoCode: (code: string) => void;
  removePromoCode: (code: string) => void;
  /** True once the cart has hydrated from localStorage. */
  ready: boolean;
};

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "minks-cart-v1";
const PROMO_KEY = "minks-promo-v1";
const MAX_CODES = 5;

function withCode(codes: string[], code: string): string[] {
  const display = code.trim().toUpperCase();
  if (!display || codes.some((c) => normalizeCode(c) === normalizeCode(display))) return codes;
  return [...codes, display].slice(-MAX_CODES);
}

function lineKey(line: Omit<CartLine, "key">): string {
  const mods = [...line.modifiers.map((m) => m.id)].sort((a, b) => a - b);
  return `${line.itemId}:${mods.join(",")}:${line.notes ?? ""}`;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [promoCodes, setPromoCodes] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  // Hydrate from localStorage after mount — deliberate setState-in-effect so
  // server and first client render agree (empty cart), avoiding hydration
  // mismatches.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration read
        if (Array.isArray(parsed)) setLines(parsed);
      }
    } catch {
      // corrupted cart — start fresh
    }
    let codes: string[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(PROMO_KEY) ?? "[]");
      if (Array.isArray(parsed)) codes = parsed.filter((c) => typeof c === "string");
    } catch {
      // corrupted codes — start fresh
    }
    // A shared link (/?promo=PIZZA10) parks its code on the cart.
    const url = new URL(window.location.href);
    const linked = url.searchParams.get("promo")?.trim();
    if (linked) {
      codes = withCode(codes, linked);
      // Saved now, not by the persist effect: StrictMode re-runs this effect
      // after the param is gone, and it must find the code in storage.
      try {
        localStorage.setItem(PROMO_KEY, JSON.stringify(codes));
      } catch {
        // storage unavailable — the code lives in state only
      }
      url.searchParams.delete("promo");
      window.history.replaceState(window.history.state, "", url);
      toast.success(`Code ${linked.toUpperCase()} added — applies at checkout`);
    }
    setPromoCodes(codes);
    setReady(true);
  }, []);

  // Gated on the `ready` STATE, not a ref: a ref flips synchronously inside the
  // hydrate effect, so this effect would run in the same commit while `lines`
  // is still empty and write that empty cart back over the saved one.
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // storage unavailable (private mode) — cart is session-only
    }
  }, [lines, ready]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(PROMO_KEY, JSON.stringify(promoCodes));
    } catch {
      // storage unavailable — codes are session-only
    }
  }, [promoCodes, ready]);

  const addPromoCode = useCallback((code: string) => setPromoCodes((prev) => withCode(prev, code)), []);
  const removePromoCode = useCallback(
    (code: string) => setPromoCodes((prev) => prev.filter((c) => normalizeCode(c) !== normalizeCode(code))),
    [],
  );

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

  const clear = useCallback(() => {
    setLines([]);
    setPromoCodes([]);
  }, []);

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
      promoCodes,
      addPromoCode,
      removePromoCode,
      ready,
    };
  }, [lines, promoCodes, ready, addLine, updateQuantity, removeLine, clear, addPromoCode, removePromoCode]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
