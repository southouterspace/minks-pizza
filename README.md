# Mink's Pizza — Online Ordering Platform

A complete online ordering platform for a single pizzeria: a public storefront
where customers browse the menu, customize pizzas, and place pickup/delivery
orders, plus an operator dashboard for menu management, store settings, and a
live orders inbox.

Payments are intentionally **not** captured yet — orders are persisted with
`payment_status = 'pending'` and the checkout path has a clean seam where
Stripe will slot in (see [Stripe readiness](#stripe-readiness)).

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
npm run db:push              # create tables in your Neon database
npm run db:seed              # optional: store settings + starter pizzeria menu
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
5. **Orders** (`/admin`) — the live board. See [Order management](#order-management) below.
6. **Kitchen display** (`/kitchen`) — the full-screen KDS for the line. See
   [Kitchen display](#kitchen-display-kds) below.
7. **Team** (`/admin/team`) — add or remove operator accounts, and change your
   own password. See [Operator accounts](#operator-accounts) below.
8. **Promotions** (`/admin/promotions`) — automatic deals and promo codes. See
   [Promotions](#promotions) below.

#### Order management

**Orders board** (`/admin`). A strip of today's numbers (orders, net sales
(item subtotal less item discounts),
average ticket, average placed-to-ready time, orders late right now), then
three lanes: **New**, **In kitchen** (confirmed and preparing) and **Ready**.
Each card shows the order number, customer, type, items, total, how long ago
it was placed and the promised time, which turns red with a **Late** flag
once it passes. The primary button moves the order one step along
`new → confirmed → preparing → ready → completed`; **+5** and **+10** push the
promised time; **Cancel** asks for a reason. The board refreshes every 15
seconds. When a new order arrives the tab chimes and its title flashes
"(1) New order" until someone taps the page; **Chime on/off** is remembered
per device. Browsers only allow sound after the first tap on the page.

Two tablets tapping the same button apply it once: the second tap gets
"Order is already confirmed." Every move is checked against one table of
legal transitions (`src/lib/order-workflow.ts`) that the kitchen display uses
too.

**History** (`/admin/orders`). Search by order number, customer name, email
or phone (digits only, so `246-8135` finds `(555) 246-8135`), and filter by
status, type and a date range in the store's time zone. The URL carries the
filters, so a search can be bookmarked or shared. **Export CSV** downloads the
same rows (up to 5,000).

**Order detail** (`/admin/orders/<id>`). Customer with tap-to-call, items with
modifiers and notes, totals, and the promised time. From here you can
advance or cancel, push the promised time (−5 to +15 min), record payment as
cash, card or other, apply a discount (see [Promotions](#promotions)), and add
internal notes. The **timeline** lists
everything that happened to the order with who did it and when: the
customer placing it, each operator action, and each status change the
kitchen display made (shown as "Kitchen display · <operator>"). **Print
ticket** prints an 80 mm receipt without the admin chrome.

**Promised time.** Checkout quotes placed time + the pickup or delivery prep
minutes from Settings. The customer's tracker shows "Ready around 6:45 PM"
while the order is cooking and the cancel reason if it was canceled.

**Time zone.** Settings → Time zone decides when the store's day starts for
the board numbers and history dates, and the clock that promised times are
shown in. Default: Central.

##### Deploying the order-management schema

Additive: two enums, an `order_events` table, five nullable `orders` columns
and `store_settings.timezone` with a default. Migrate before deploying the
code:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push
```

Orders placed before the migration have no promised time and no audit rows;
their timeline starts with a synthetic "Order placed".

#### Operator accounts

`/admin/setup` is a **first-run-only** page: it creates the very first operator
and then locks itself permanently — both the page and the server action bail out
to `/admin/login` once any operator exists. There is no public sign-up, because
an open sign-up on `/admin` would let any visitor create an admin account on a
live store.

Every subsequent account is created from **Team** by someone already signed in.
The creator sets an initial password and passes it on out of band; the new
operator can replace it from the same page. Two things to know:

- **There are no roles.** Every operator has full access to the menu, orders and
  settings.
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

### Promotions

Built from operator and customer complaints about Toast, Square, Domino's and
the delivery apps (see `docs/promotions-research.md`).

**Creating a deal** (`/admin/promotions` → **New deal**). Start from a
template (percent off the order, dollars off, BOGO, item deal price, free
delivery, happy hour) and adjust. The right-hand card shows the sentence
customers will read, for example "20% off orders $30+. Pickup orders only.
Valid Tue 3–6 PM. Once per customer. Use code PIZZA10."

| Setting | What it does |
|---|---|
| How customers get it | **Automatically** (applies itself when the cart qualifies) or **With a code** |
| Reward | % or $ off the order (optional cap), % or $ off items, a deal price on items ("any large $12"), buy X get Y (the discounted units are always the cheapest qualifying ones), free delivery (delivery orders only) |
| Which items | Any mix of categories, items and modifiers such as a size. Nothing picked means any item |
| When it applies | Minimum item subtotal, pickup and/or delivery, first and last day, weekly time windows on the store's clock |
| Limits | Uses per customer (by phone number), total uses, new customers only (no earlier order on that phone) |
| Combines with other combinable deals | Off: the deal is exclusive. On: it stacks with every other combinable deal |
| Show on the menu page | Off makes a private code for a mailer or partner |

**Codes.** On a code deal's page, add a shared code such as `PIZZA10`, or
generate up to 1,000 single-use codes (`MINK-7KQ2-X9`) and download them as
CSV. Single-use codes are worthless on coupon sites. **Copy link** gives a
`/?promo=PIZZA10` link that puts the code in the customer's cart. Codes match
ignoring case, spaces and dashes. Deleting a code stops it working at once;
orders that used it keep their discount.

**Running a deal.** The switch pauses and resumes it. **Archive** retires a
used deal; a deal no order used can be deleted. Editing a deal never changes
orders already placed: each order keeps a snapshot of its discount lines. The
list shows status (Active, Scheduled, Expired, Paused, Used up, Archived),
uses against the limit, the total discounted and net sales from orders that
used it. Uses count only orders that weren't canceled, so canceling an order
gives its use back. Staff discounts made from a deal's preset count in its
total discounted and net sales but never use up its limits.

**Apply discount** on an order's page takes dollars or a percent off the
items with a reason that prints on the receipt, or one tap on a live
whole-order deal (for a customer who forgot their code). It works while
payment is pending and the order is open, recomputes tax and total, and
appears in the timeline. A staff discount can be removed the same way.

**What customers see.** The menu page lists advertised deals with a copy
button for the code. Cart and checkout have a **Have a promo code?** field,
list each deal on its own line with the saving ("Applied automatically" for
automatic ones), say exactly why a code doesn't apply ("Add $4.50 more to use
PIZZA10", "Valid Tue 3–6 PM", "Already used with this phone number"), and show
nudges such as "Add $3.20 more for free delivery". Codes stay with the cart
through edits and refreshes; a code that stops qualifying stays attached and
applies again when the cart qualifies. The confirmation shows each discount
and "You saved $5.00".

**Best deal and money rules.** The customer always gets the best legal
combination: each exclusive deal on its own, or all combinable deals
together, whichever saves more. A code that loses says "A better deal is
already applied: …". Item discounts round half-up per unit and never take a
unit below zero; order discounts apply to what is left. Tax is on items after
discounts. Tips are a share of the pre-discount subtotal and never
discounted. Totals are always the server's: cart and checkout ask the same
function that places the order, and the order is refused, with the new total,
if they ever differ. Limits hold when checkouts race: the last use goes to
exactly one order and the other customer reads "PIZZA10 was just fully
redeemed — your total is now $X."

#### Deploying the promotions schema

Additive: three enums, the `promotions`, `promotion_codes` and
`order_discounts` tables, `orders.discount_cents` (default 0) and a
`discount` value on `order_event_type`. Checkout reads the new tables, so
migrate before deploying the code:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push
```

Orders placed before the migration have `discount_cents = 0` and no
discount lines.

`orders.customer_key` (the phone's last ten digits, which promotion limits
count against) is a generated column, so Postgres fills it for existing
orders during the same push. No backfill step.

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
  (subtotal, discount, tax, delivery fee, tip, total) and `payment_status`
  (`pending`/`paid`/`refunded`).
- `src/lib/orders.ts` → `createOrder()` is the single seam: create a
  PaymentIntent for `totalCents` there, store its id, and flip
  `payment_status` from a Stripe webhook. `placeOrder` in
  `src/app/(store)/actions.ts` already returns a structured result to which a
  client secret can be added.

## Project layout

```
src/
  db/            schema.ts (Drizzle), seed.ts, index.ts (client)
  lib/           menu.ts, orders.ts (pricing + creation), auth.ts, validation.ts,
                 order-workflow.ts (order lifecycle rules, pure),
                 order-writes.ts (logged status/ETA/payment/note writes),
                 order-queries.ts (board, history search, export, detail, day stats),
                 promotions.ts (reward union and best-deal evaluator, pure),
                 promotion-queries.ts (candidates and usage from the ledger),
                 promotion-admin.ts (operator list, stats, codes),
                 kds.ts (kitchen display rules, pure), kds-server.ts (queries + actions)
  app/(store)/   customer storefront (menu, cart, checkout, order status)
  app/admin/     operator dashboard (orders board, history + detail, menu,
                 modifiers, promotions, settings, team); CSV exports in app/api/admin
  app/kitchen/   kitchen display (KDS); data via app/api/kds
  components/    cart context, storefront + admin UI
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
8. **Refunds** (the `refunded` payment status exists but nothing sets it
   yet). Promotions shipped (see [Promotions](#promotions)); follow-ups:
   customer identity beyond the phone number once accounts or Stripe card
   fingerprints exist, a redemption velocity alert for leaked codes, and an
   audit log of deal edits
9. **KDS follow-ups** (from `docs/kds-research.md`): half-and-half pizzas end
   to end (ordering, pricing and a left/right ticket layout, the most-requested
   pizza KDS feature); a kitchen-only role so the display tablet doesn't carry
   full admin access; promised-time sorting once scheduled orders exist

See `NOTES.md` for the build log and decision record.
