"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";
import { DEFAULT_CHOICE, PLACEMENTS, PORTIONS, type Placement, type Portion } from "@/lib/toppings";

export type CartModifier = {
  id: number;
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
  /** Toppings only; absent means whole and regular. */
  placement?: Placement;
  portion?: Portion;
};

export type CartLine = {
  /** Stable key: item + sorted modifier choices + notes. Same config merges. */
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
  const mods = [...line.modifiers]
    .sort((a, b) => a.id - b.id)
    .map((m) => {
      const placement = m.placement ?? DEFAULT_CHOICE.placement;
      const portion = m.portion ?? DEFAULT_CHOICE.portion;
      return placement === DEFAULT_CHOICE.placement && portion === DEFAULT_CHOICE.portion
        ? `${m.id}`
        : `${m.id}/${placement}/${portion}`;
    });
  return `${line.itemId}:${mods.join(",")}:${line.notes ?? ""}`;
}

const storedLineSchema = z.object({
  itemId: z.number().int().positive(),
  itemName: z.string(),
  unitPriceCents: z.number().int(),
  quantity: z.number().int().min(1),
  modifiers: z.array(
    z.object({
      id: z.number().int().positive(),
      groupName: z.string(),
      modifierName: z.string(),
      priceDeltaCents: z.number().int(),
      placement: z.enum(PLACEMENTS).optional(),
      portion: z.enum(PORTIONS).optional(),
    }),
  ),
  notes: z.string().optional(),
});

/**
 * Reads a saved cart, including ones saved before toppings had halves and
 * portions (their modifiers lack both, which means whole and regular). Keys
 * are recomputed so old lines merge with new ones; unreadable lines drop.
 */
function parseStoredCart(raw: string): CartLine[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const line = storedLineSchema.safeParse(entry);
    return line.success ? [{ ...line.data, key: lineKey(line.data) }] : [];
  });
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);

  // Hydrate from localStorage after mount — deliberate setState-in-effect so
  // server and first client render agree (empty cart), avoiding hydration
  // mismatches.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration read
      if (raw) setLines(parseStoredCart(raw));
    } catch {
      // corrupted cart — start fresh
    }
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
