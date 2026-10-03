# Mink's Pizza — Online Ordering Platform

A complete online ordering platform for a single pizzeria: a public storefront
where customers browse the menu, customize pizzas, and place pickup/delivery
orders, plus an operator dashboard for menu management, store settings, and a
live orders inbox.

Online payments are intentionally **not** captured yet: online orders are
paid at pickup, and payments are recorded at the counter as tenders (see
[Front-of-house POS](#front-of-house-pos-server-layer)). The checkout path
has a clean seam where Stripe will slot in (see
[Stripe readiness](#stripe-readiness)).

## Stack

- **Next.js 16** (App Router, Server Components, Server Actions), TypeScript
- **Tailwind CSS v4** + **shadcn/ui** (Base UI variant, Nova preset) — minimal
  Vercel-style design system
- **Neon Postgres** + **Drizzle ORM** (`@neondatabase/serverless` over HTTP)
- **Auth**: email + password for the operator (bcrypt), jose-signed JWT session cookie

### UI components

Components live in `src/components/ui/` and are built on
[Base UI](https://base-ui.com) primitives with the shadcn **Nova** preset.
Component styles are the `.cn-*` classes in `src/styles/style-nova.css`, scoped
by the `style-nova` class on `<html>`; design tokens live in
`src/app/globals.css`. `components.json` records the configuration, so
`npx shadcn@latest add <component>` will add more in the same style.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in values (see below)
npm run db:migrate-pos       # existing databases only; a no-op on a fresh one
npm run db:push              # create tables in your Neon database
npm run db:seed              # optional: store settings, demo POS staff, starter menu
npm run dev
```

`.env.local`:

| Variable | Purpose |
|---|---|
| `MINKS_DATABASE_URL` (or `DATABASE_URL`) | Neon Postgres connection string. `MINKS_DATABASE_URL` wins when both are set. |
| `SESSION_SECRET` | 32+ byte hex secret for session cookies (`openssl rand -hex 32`) |

## The two sides of the platform

### Operator (`/admin`)

1. Visit `/admin` — on first run you're redirected to **/admin/setup** to create
   your operator account.
2. **Menu** — create categories, items, and prices; attach modifier groups
   (Size, Crust, Toppings…); toggle availability to 86 an item instantly.
3. **Modifiers** — reusable option groups with required/optional rules
   (`minSelect`/`maxSelect`) and per-option price deltas.
4. **Settings** — store identity (including a **logo**: upload an image up to
   4 MB or paste a hosted URL; it renders at its natural shape in place of the
   initial badge), hours, pickup/delivery toggles, prep times, delivery
   fee/minimum, tax rate — and the **Publish** switch that takes the storefront
   live (before that, customers see a coming-soon page). A separate
   **Accepting orders** switch pauses ordering without unpublishing.
   **Point of sale** settings: the half-topping rule, the extra-topping
   multiplier, the discount amount above which a manager must approve, oven
   capacity and make time (they set the quoted wait), POS auto-lock, and the
   store **timezone** (default `America/Chicago`), which decides where report
   days start and end and how admin times print. Each is range-checked on the
   server.
5. **Orders** (`/admin`) — live inbox that auto-refreshes. Each card shows
   the kitchen status (driven by the KDS: `new → preparing → ready →
   completed`), a channel badge (Online, Phone, Walk-in, Dine-in) and the
   payment state (Unpaid, Part paid, Paid, Refunded). An order with a balance
   due has a **Collect at POS** link to `/pos?order=<id>`, and **Activity**
   opens the order's log: placed, sent, voids, comps, discounts, payments and
   refunds, with who did each and who approved it. Scheduled orders wait in
   their own lane until they fire.
6. **Kitchen display** (`/kitchen`) — the full-screen KDS for the line. See
   [Kitchen display](#kitchen-display-kds) below.
7. **Reports** (`/admin/reports`) — pick a day (store-local) to see its
   shifts with who opened and closed them and cash and card over/short, plus
   the day's sales. Each shift opens a printable **Z report** (letter or 80mm
   receipt): sales by channel, tenders by method with tips and refunds, the
   drawer count (expected vs counted cash, card total vs the terminal batch
   the closer entered, cash tips declared), every void, comp, discount,
   refund, no-sale, paid-in and paid-out with employee, approver and reason,
   unpaid orders, and canceled orders that still hold money. The day report
   is the same document without the drawer. Order lines and tenders export as
   CSV for a shift or a day (`/api/admin/reports/lines|tenders?shift=<id>` or
   `?date=YYYY-MM-DD`, operator session required). All of it comes from the
   same `shiftReport` fold the POS shift close uses.
8. **Team** (`/admin/team`) — POS staff and operator accounts. Add staff with
   a name, a role (cashier, manager, owner) and a 4-digit PIN, set a new PIN,
   or deactivate them. A PIN is stored only as a keyed digest and never shown
   again; it must be unique among active staff, because the POS finds who
   typed it by that digest. The last active manager or owner can't be
   deactivated, since nobody could then approve voids or close a shift. Also
   add or remove operator accounts and change your own password. See
   [Operator accounts](#operator-accounts) below.

#### Operator accounts

`/admin/setup` is a **first-run-only** page: it creates the very first operator
and then locks itself permanently — both the page and the server action bail out
to `/admin/login` once any operator exists. There is no public sign-up, because
an open sign-up on `/admin` would let any visitor create an admin account on a
live store.

Every subsequent account is created from **Team** by someone already signed in.
The creator sets an initial password and passes it on out of band; the new
operator can replace it from the same page. Two things to know:

- **There are no operator roles.** Every operator has full access to the menu,
  orders, staff, reports and settings. Roles (cashier, manager, owner) apply to
  POS staff only.
- **You cannot remove your own account.** That restriction is what guarantees at
  least one operator always exists — at zero accounts `/admin/setup` would
  unlock itself and the store could be claimed by anyone.

### Kitchen display (KDS)

`/kitchen` is a full-screen, dark, touch-first kitchen display built from
operator feedback on Toast, Square and other KDS products, weighted toward
pizzerias (see `docs/kds-research.md`). Open it on any tablet or TV signed in
as an operator and tap **Start kitchen display** once, so it can chime and keep
the screen awake.

**Stations.** Each menu category routes to a station (Menu → category → Edit →
*Kitchen station*): **Pizza line**, **Kitchen** (wings, knots, salads) or
**Counter** (drinks and anything with no prep; shown on the ticket but never
holds an order back). Each order line copies its category's station at
checkout, so re-routing a category doesn't reshuffle tickets already on the
line. Each screen remembers its own station choice:

| Screen | Shows | Tap an item | Bump |
|---|---|---|---|
| All | every open ticket (expo or one-screen shops) | advance one stage | finish the whole order |
| Make line | tickets with pies not yet fired | into the oven | fire every pie on the ticket |
| Oven | pies in the oven, each with a bake countdown | out, cut and boxed | pull every pie on the ticket |
| Kitchen | tickets with non-pizza kitchen items | done | finish the kitchen items |
| Ready | bumped orders waiting for the customer or driver | | picked up / out for delivery |

An order becomes **ready** on its own when every item that needs cooking is
finished, and any tap on its items moves it to **preparing**. The customer's
order tracker reflects both.

**Reading a ticket.** Size and crust come first as chips, because they decide
which dough ball to grab. Toppings show as `+ Pepperoni`. Removals (`No …`)
are red and uppercase, amount changes (`Extra …`, `Light …`) are amber, and
item notes and order notes (allergies) sit in yellow boxes. Quantities above
one are highlighted. The header shows the order number, PICKUP or DELIVERY,
and a timer that turns amber and then red at the thresholds set in
**Settings → Kitchen display**, which also sets the oven bake time.

**During a rush.**
- **All-day** panel (`A`): unmade quantities across all tickets by item and
  size, for example "6 Cheese Pizza Large 14"".
- **Recall** (`R`): orders bumped in the last two hours. Recalling puts the
  ticket back on the line from the start. Every finishing bump also shows an
  **Undo** toast.
- **Bump bar / keyboard:** `1`–`9` or the arrow keys select a ticket, and
  `Enter` or `Space` bumps it. Most USB bump bars send these keys.
- New orders chime and flash. An order canceled while it is on screen raises
  a red "pull it" banner.
- If the connection drops, the tickets stay on screen under a red banner
  that shows when they were last synced. Polling resumes on its own.
- Text size (A−/A+) and the sound toggle are saved per screen.

The display polls `GET /api/kds` every 4 seconds. Taps update the screen
immediately and are sent to `POST /api/kds`. Each action is idempotent, so
a double tap or a retry is harmless.

#### Deploying the KDS schema

The KDS adds columns, so **migrate the production database before deploying
this code**. Checkout reads `categories.station`, so the old schema breaks
ordering.

```bash
MINKS_DATABASE_URL=<production url> npm run db:push   # additive: new enum + columns with defaults
```

Then route the existing categories (or do it in Menu → Edit):

```sql
update categories set station = 'pizza'   where name ilike '%pizza%' or name ilike 'build your own%';
update categories set station = 'counter' where name ilike '%drink%' or name ilike '%beverage%';
```

Orders placed before the migration default to the Kitchen station.

### Front-of-house POS (server layer)

The counter POS (walk-in, phone, some dine-in) shares one order seam with the
storefront and the KDS. The terminal is `/pos` (see [the terminal](#the-pos-terminal)).

- **Staff and PINs.** A device signed in as an operator unlocks the POS;
  staff then switch with a 4-digit PIN, which sets a short `minks_staff`
  cookie (`store_settings.pos_lock_seconds`). PINs are stored as
  `HMAC-SHA256(SESSION_SECRET, pin)`, so rotating `SESSION_SECRET` means
  re-setting every PIN. Five wrong PINs in five minutes lock the device for
  the rest of the window. `npm run db:seed` adds two demo staff:

  | Name | Role | PIN |
  |---|---|---|
  | Morgan Manager | manager | `1234` |
  | Casey Cashier | cashier | `5678` |

- **Manager approval.** Voiding a line already sent to the kitchen, comps,
  discounts over `discount_approval_cents`, refunds, no-sale, paid-out and
  shift close need a manager. The server checks at the moment of the action;
  a cashier gets `needs_manager` and resends the same request with the
  manager's PIN. Who acted and who approved are stored on the fact row.
- **Money.** Tenders (cash, card on the external terminal), refunds,
  discounts and comps are rows. `orders.subtotal/discount/tax/total/paid/
  refunded_cents` are folds over them, written only by the fold statement
  that ends every write; payment state (`unpaid / partial / paid / refunded`)
  is derived, never stored. Tax uses `orders.tax_rate_bps`, the store rate
  snapshotted when the order was placed, so changing the store rate never
  re-taxes an older order that is paid or edited later.
- **Halves.** Each topping on a line carries `placement` (whole, left,
  right) and `amount` (regular, extra, light, none). Placement is allowed
  only in sauce, cheese and topping groups (`modifier_groups.role`). The
  half rule is `store_settings.half_topping_rule`: `average` (also what
  "half price per half topping" works out to) or `highest`. A Large Cheese
  ($16.99) with Pepperoni ($1.75) on the left and Mushrooms ($1.50) on the
  right is $18.62 under `average` and $18.74 under `highest`.
- **Scheduled and held orders.** An order with a fire time is `held` and
  stays off the KDS until a KDS or POS board poll fires it.
- **Replays.** Every POS write carries client-minted UUIDs and is one
  convergent `db.batch`, so a retried submit, tender or void lands once.

Wire API: `POST /api/pos/orders` (the replayable submit), `GET
/api/pos/menu`, `GET /api/pos/customers?phone=`, `GET /api/pos/board`; the
interactive verbs are server actions in `src/app/pos/actions.ts`.

#### The POS terminal

`/pos` is a full-screen, touch-first counter screen for a tablet or a
1366×768 laptop. Like `/kitchen`, the device signs in as an operator; staff
then unlock it with their PIN, and it locks again after
`store_settings.pos_lock_seconds` of idle time (or after each order, a
per-device toggle in the staff menu).

- **Order entry.** Pick Walk-in, Phone, Delivery or Dine-in. Phone and
  Delivery start on the caller's number, which brings up their name, saved
  addresses and last orders with one-tap Reorder (re-priced today; 86'd
  items are listed, not added). Pizzas open the builder: size, crust, then a
  toppings grid where a tap cycles regular, extra, light and off, Whole /
  Left ½ / Right ½ picks the half, and a long-press moves one topping
  between halves. Totals come from `priceLine` on the device, so entry never
  waits on the network. A walk-in 2 × half-and-half large paid with a $50 is
  11 taps.
- **Paying.** Cash (exact, $20, $50, $100 or any amount, with change due),
  card on the separate terminal (amount, tip, optional last 4), several
  tenders in a row, an even split by 2 to 4, or pay later.
- **Open orders.** Every open order across channels, searchable by name,
  phone or number, with lanes for held, in kitchen, ready and unpaid. An
  order opens to collect payment, add to a dine-in check, fire held lines,
  void, comp, discount, split by item, refund, cancel, hand off, reprint the
  receipt and read its activity log. `/pos?order=<id>` opens one directly.
  Anything that needs a manager pops a manager PIN pad and resends the same
  request.
- **Shift.** Open with a starting bank; no sale, paid in and paid out from
  the staff menu; close with counted cash, the card batch total and declared
  cash tips, which shows expected vs counted and links to the Z report.
- **Offline.** A new order is saved in the browser (IndexedDB) before it is
  sent. If it can't reach the server it shows as NOT SENT in red, prints a
  paper kitchen ticket, and replays automatically; a replay can't double-ring
  because the order id is minted on the device. The kitchen screen needs the
  internet too, so the paper ticket is the kitchen's copy until it returns.
  Payments and changes to existing orders need the connection.

Receipts and fallback tickets print through the browser at 80mm width.

```bash
npx tsx scripts/test-pos-client.ts                          # builder, draft and totals rules
npx tsx --env-file=.env.local scripts/e2e-pos.ts            # every terminal flow, against a test branch
```

#### Deploying the POS schema

The POS changes the order status enum, drops `orders.payment_status`, and
reshapes stored line modifiers, so **migrate before deploying this code**,
in this order:

```bash
MINKS_DATABASE_URL=<production url> npm run db:migrate-pos  # enum swap, backfills; safe to re-run
MINKS_DATABASE_URL=<production url> npm run db:push         # additive rest: new tables and columns
MINKS_DATABASE_URL=<production url> npm run db:seed         # optional: demo staff (skips existing menu)
```

`scripts/migrate-pos.sql` is one `DO` block (also runnable with `psql -f`).
It maps `confirmed` orders to `new`, refuses to run if any order has a
`payment_status` other than `pending` (no code path ever wrote one), sets
group roles from their names (Size, Crust, `*topping*`), marks existing lines
as fired at their order's placed time, backfills `customers` from every
phone number already on an order, and adds `orders.tax_rate_bps`. The tax
backfill uses the current store rate when it reproduces an order's stored
`tax_cents` (every order, unless the rate changed since it was placed), and
otherwise the rate that order's own tax implies. It does not simply divide tax
by taxable for every row: tax was rounded to the cent, so $3.07 on $37.24 at
8.25% reads back as 8.24%.

### Customer (`/`)

Menu browsing with category navigation → item customization dialog (sizes,
crusts, toppings with live price updates, quantity, special instructions) →
cart (persisted in localStorage) → checkout (pickup/delivery, contact details,
address for delivery, tip presets, order notes) → order confirmation page with
a live status tracker.

All pricing is authoritative server-side: the cart submits only item/modifier
ids, and the server re-validates availability, modifier rules, delivery
minimums, and recomputes every price at order time.

## Stripe readiness

- Money is integer cents everywhere; `orders` carries a full breakdown
  (subtotal, discount, tax, delivery fee, tip, total) and the ledger folds
  `paid_cents` / `refunded_cents` over the `tenders` table.
- `submitOrder()` in `src/lib/orders-server.ts` is the single seam: create a
  PaymentIntent for the total after it, and record the captured payment as a
  `tenders` row (with no shift) from the Stripe webhook. `placeOrder` in
  `src/app/(store)/actions.ts` already returns a structured result to which a
  client secret can be added.

## Project layout

```
src/
  db/            schema.ts (Drizzle), seed.ts, index.ts (client)
  lib/           menu.ts, auth.ts, validation.ts (zod at the boundaries),
                 pricing.ts (line pricing + half rule, pure),
                 orders.ts (order domain: payment state, role policy, report folds, pure),
                 orders-server.ts (submitOrder / mutateOrder seam, folds, reads),
                 reports-server.ts (shift list, day report, CSV exports),
                 store-time.ts (store-local days and times),
                 staff.ts + pin.ts (staff cookie, PIN lookup and lockout),
                 kds.ts (kitchen display rules, pure), kds-server.ts (queries + actions),
                 pos-client/ (terminal draft + builder rules, pure), pos-outbox.ts (offline queue)
  app/(store)/   customer storefront (menu, cart, checkout, order status)
  app/admin/     operator dashboard (orders, menu, modifiers, reports, settings, team)
  app/kitchen/   kitchen display (KDS); data via app/api/kds
  app/pos/       POS terminal + server actions; data via app/api/pos/*
  components/    cart context, storefront, admin, kitchen and pos UI
```

## Roadmap

Informed by industry research (see `docs/RESEARCH.md`), roughly in order:

1. **Stripe payment capture** — the seam is ready (see above)
2. **Half-and-half toppings & per-size topping pricing** — the most
   pizza-specific gaps; both touch the pricing engine, build together
3. **Scheduled orders** (ASAP vs later) and rush-aware prep-time estimates
4. **SMS status notifications** — cuts "where's my order" calls
5. **Delivery zones** (radius/ZIP validation, tiered fees)
6. **Allergen/dietary tags & item photos** (schema already has `imageUrl`)
7. **Customer accounts with saved addresses & one-tap reorder** — optional,
   post-purchase (guest checkout stays the default)
8. **Coupons/promo codes; printable kitchen tickets**
9. **KDS follow-ups** (from `docs/kds-research.md`): half-and-half pizzas end
   to end (ordering, pricing and a left/right ticket layout, the most-requested
   pizza KDS feature); a kitchen-only role so the display tablet doesn't carry
   full admin access; promised-time sorting once scheduled orders exist

See `NOTES.md` for the build log and decision record.
