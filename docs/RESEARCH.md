# Industry Research: Online Pizza Ordering UX

Research pass over Domino's, Slice, Toast, Square Online, ChowNow, and
restaurant-ordering UX literature, used to validate and steer this platform's
feature set. Condensed findings; conducted 2026-08-12.

## What this build gets right (validated against industry practice)

- **Single-page menu + category jump nav** — the standard Toast/Square/ChowNow
  storefront pattern; avoids page hops that increase abandonment.
- **Modifier architecture** (reusable groups, required single-select radios for
  Size/Crust, optional multi-select toppings with price deltas, min/max rules)
  — matches POS-grade modifier modeling; the right abstraction for pizzerias.
- **Guest checkout, no forced accounts** — forced account creation drives
  24–37% checkout abandonment (Baymard-style guidance: guest-first, offer
  accounts *after* purchase).
- **Server-side re-pricing and validation** — prevents kitchen tickets that
  don't match what was charged; the canonical failure mode of naive carts.
- **Tip presets + custom** — universal pattern (Toast, Square, DoorDash).
- **4-stage order tracker** (received → confirmed → preparing → ready) —
  in line with Domino's own simplification of its Pizza Tracker to four stages.
- **Operator controls**: 86-toggle, publish switch, pause-ordering switch,
  auto-refreshing order inbox with status transitions — standard across
  Toast/Square Online/ChowNow admin panels.

## Known gaps (ranked), triaged

| Gap | Effort | v1 disposition |
|---|---|---|
| Half-and-half / split-topping pizzas | Large | Roadmap — most pizza-specific gap; touches pricing engine |
| Per-size topping pricing (delta varies by size) | Medium | Roadmap — pairs with half-and-half |
| Dynamic prep-time / rush-aware ETA (vs static estimate) | Medium | Roadmap — operator has manual prep-time + pause switch in v1 |
| SMS order-status notifications | Medium | Roadmap — needs SMS provider; in-app tracker only in v1 |
| No-show protection for pay-at-pickup | Small | Arrives with Stripe (card hold); accepted v1 risk, documented |
| Allergen/dietary flags | Small | Roadmap — add to menu CRUD |
| Duplicate order guard (double-tap submit) | Small | **Fixed in v1** — submit guard in checkout form |
| Printable kitchen tickets | Medium | Roadmap — screen inbox in v1 |
| Delivery zones (radius/ZIP) | Medium | Roadmap — delivery minimum + fee only in v1 |
| Item photos | Small | Schema supports `imageUrl`; UI on roadmap |

## Persona risks noted for future iterations

- **Phone customer**: modifier dialog density on small screens; no
  half-and-half forces phone calls; re-pricing failures must explain what
  changed (v1 mitigates with specific per-item error messages).
- **Operator mid-rush**: static prep estimates over-promise as queue grows;
  new orders need an unmissable signal (sound/flag) beyond an auto-refreshing
  list; pause is binary where operators often want to throttle.

## Sources

- Slice — The complete guide to online ordering for independent pizzerias
- Toast Support — Getting started with online ordering; SMS fulfillment texts
- ChowNow — Direct online ordering product docs
- Fast Company / NRN — Domino's Pizza Tracker evolution
- Hospitality Technology / NoFraud — guest checkout & abandonment data
- HungerRush — order notifications launch (rush-hour call reduction)
- RadiusMapper — delivery-zone planning
