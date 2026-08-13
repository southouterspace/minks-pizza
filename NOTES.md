# Mink's Pizza — Build Notes

Working log + decision record for the online pizza ordering platform build.
Maintained continuously during the autonomous build session (2026-08-12).

## Goal

A fully functioning online pizza ordering platform:
- **Operator** can set up their menu and store, then publish it to customers.
- **Customers** browse the public menu, customize pizzas, build a cart, and submit
  orders — everything up to (but excluding) payment capture. Checkout is
  Stripe-ready: orders are persisted with `payment_status = 'pending'` and the
  submission path has a clean seam where a Stripe PaymentIntent will slot in.

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16.3 (App Router, already scaffolded) | Repo convention; AGENTS.md mandates reading bundled docs first (breaking changes vs 14/15) |
| Database | Neon Postgres — project `misty-violet-36824705`, branch `main`, db `neondb` | Available connector; serverless-friendly |
| ORM | Drizzle + @neondatabase/serverless | Type-safe, SQL-first, works over HTTP |
| Auth (operator) | Email + password (bcryptjs) with jose-signed JWT session cookie | Single-tenant admin; no external IdP dependency |
| Cart | Client-side (localStorage + React context), re-validated server-side on order submit | Standard practice; server is source of truth for prices |
| Styling | Tailwind v4, Vercel-like aesthetic (white/near-black, Geist, 1px borders, minimal) | Requested |
| Payments | Not captured in v1. `orders.payment_status='pending'`, checkout server action isolated in `src/lib/orders.ts` for Stripe insertion later | Requested seam |

## Architecture

- `/` + `/menu` — public storefront (menu browsing, item customization modal, cart)
- `/checkout` — customer details, order type (pickup/delivery), tip, submit
- `/order/[id]` — order confirmation / status page
- `/admin` — operator dashboard (orders inbox, menu CRUD, store settings)
- `/admin/setup` — first-run operator account creation (only when no operator exists)
- `/admin/login` — operator sign-in
- Store publish state gates the storefront: unpublished → "coming soon" page.

## Data model (v1)

- `operators` — admin accounts (email, password_hash)
- `store_settings` — singleton row: name, tagline, phone, address, hours (jsonb),
  order types, prep times, delivery fee/minimum, tax rate, `is_published`,
  `is_accepting_orders` (pause switch)
- `categories` → `menu_items` (base_price in cents, availability toggle = 86'ing)
- `modifier_groups` (required/optional, min/max select) → `modifiers` (price delta);
  junction `item_modifier_groups`. Sizes are modeled as a required single-select
  modifier group — keeps one mechanism for sizes/crusts/toppings.
- `orders` — status flow `new → confirmed → preparing → ready → completed`
  (+ `canceled`), order_type, customer contact, money columns in cents,
  `payment_status` ('pending' until Stripe lands)
- `order_items` — denormalized snapshots (name, unit price, chosen modifiers as
  jsonb) so menu edits never corrupt past orders

## Work log

- [x] Scaffold Next.js 16.3 + Tailwind v4 (create-next-app)
- [x] Neon project created: `misty-violet-36824705` (us-west-2)
- [x] Deps: drizzle-orm, @neondatabase/serverless, drizzle-kit, zod, bcryptjs, jose, tsx
- [x] Research agent dispatched: industry UX/feature research (Domino's, Slice, Toast, Square…)
- [x] Docs agent dispatched: Next.js 16.3 breaking-changes brief from bundled docs
- [ ] Drizzle schema + migration pushed to Neon
- [ ] Seed script (demo menu: classic pizzeria categories/items/modifiers)
- [ ] Operator auth (setup/login/session)
- [ ] Admin: store settings + publish toggle
- [ ] Admin: menu management (categories, items, modifier groups)
- [ ] Admin: orders inbox with status transitions
- [ ] Storefront: menu, item customization, cart
- [ ] Checkout: details + validation + order creation (Stripe-ready seam)
- [ ] Order confirmation/status page
- [ ] Build passes, end-to-end smoke test (operator flow + customer flow)
- [ ] Final: README, push

## Decisions & findings

- 2026-08-12: Container restarted once mid-session; disk survived, background
  agents had to be relaunched. Note: keep commits frequent.
- `.env*` is gitignored by the scaffold — `DATABASE_URL` + `SESSION_SECRET` live in
  `.env.local` (documented in README; `.env.example` committed).
- Money is always integer cents. Tax computed at checkout from
  `store_settings.tax_rate_bps` (basis points) to avoid float drift.
