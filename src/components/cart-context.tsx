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
import { z } from "zod";
import { displayCode, normalizeCode } from "@/lib/promo-code";
import { DEFAULT_CHOICE, type Placement, type Portion } from "@/lib/toppings";
import { cartModifierSchema, type CartLineInput } from "@/lib/validation";

export type CartModifier = {
  id: number;
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
  placement?: Placement;
  portion?: Portion;
};

export type CartLine = {
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
  /** What the customer last picked, clamped to what the store offers, so cart and checkout quote the same thing. */
  orderType: OrderType;
  setOrderType: (orderType: OrderType) => void;
  orderTypes: Record<OrderType, boolean>;
  /** True once the cart has hydrated from localStorage. */
  ready: boolean;
};

export type OrderType = "pickup" | "delivery";

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "minks-cart-v1";
const PROMO_KEY = "minks-promo-v1";
const ORDER_TYPE_KEY = "minks-order-type-v1";
const MAX_CODES = 5;

function withCode(codes: string[], code: string): string[] {
  const display = displayCode(code);
  if (!display || codes.some((c) => normalizeCode(c) === normalizeCode(display))) return codes;
  return [...codes, display].slice(-MAX_CODES);
}

/** What the server prices: ids and topping choices only, never the client's prices. */
export function toCartLineInput(line: CartLine): CartLineInput {
  return {
    itemId: line.itemId,
    quantity: line.quantity,
    modifiers: line.modifiers.map((m) => ({ id: m.id, placement: m.placement, portion: m.portion })),
    notes: line.notes,
  };
}

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
    cartModifierSchema.extend({
      groupName: z.string(),
      modifierName: z.string(),
      priceDeltaCents: z.number().int(),
    }),
  ),
  notes: z.string().optional(),
});

function parseStoredCart(raw: string): CartLine[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const line = storedLineSchema.safeParse(entry);
    return line.success ? [{ ...line.data, key: lineKey(line.data) }] : [];
  });
}

export function CartProvider({
  orderTypes,
  children,
}: {
  orderTypes: Record<OrderType, boolean>;
  children: React.ReactNode;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [promoCodes, setPromoCodes] = useState<string[]>([]);
  const [picked, setOrderType] = useState<OrderType>("pickup");
  const [ready, setReady] = useState(false);
  const orderType: OrderType = orderTypes[picked] ? picked : orderTypes.pickup ? "pickup" : "delivery";

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
    try {
      const parsed = JSON.parse(localStorage.getItem(PROMO_KEY) ?? "[]");
      if (Array.isArray(parsed)) setPromoCodes(parsed.filter((c) => typeof c === "string"));
    } catch {
      // corrupted codes — start fresh
    }
    try {
      const saved = localStorage.getItem(ORDER_TYPE_KEY);
      if (saved === "pickup" || saved === "delivery") setOrderType(saved);
    } catch {
      // storage unavailable — default to pickup
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
      localStorage.setItem(PROMO_KEY, JSON.stringify(promoCodes));
      localStorage.setItem(ORDER_TYPE_KEY, picked);
    } catch {
      // storage unavailable (private mode) — cart is session-only
    }
  }, [lines, promoCodes, picked, ready]);

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
      orderType,
      setOrderType,
      orderTypes,
      ready,
    };
  }, [lines, promoCodes, orderType, orderTypes, ready, addLine, updateQuantity, removeLine, clear, addPromoCode, removePromoCode]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

export function announceCodeAdded(code: string) {
  toast.success(`Code ${displayCode(code)} added — applies at checkout`);
}

/**
 * A shared link (/?promo=PIZZA10) parks its code on the cart once the cart
 * has loaded, then drops the param, so a re-run finds nothing to add.
 */
export function PromoLinkCapture() {
  const { ready, addPromoCode } = useCart();
  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    const linked = url.searchParams.get("promo")?.trim();
    if (!linked) return;
    addPromoCode(linked);
    url.searchParams.delete("promo");
    window.history.replaceState(window.history.state, "", url);
    announceCodeAdded(linked);
  }, [ready, addPromoCode]);
  return null;
}
