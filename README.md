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
5. **Orders** (`/admin`) — live inbox that auto-refreshes; move orders through
   `new → confirmed → preparing → ready → completed` (or cancel).
6. **Kitchen display** (`/kitchen`) — the full-screen KDS for the line. See
   [Kitchen display](#kitchen-display-kds) below.
7. **Team** (`/admin/team`) — add or remove operator accounts, and change your
   own password. See [Operator accounts](#operator-accounts) below.
8. **Staff** (`/admin/staff`) — employees, the weekly schedule, timesheets and
   time off, plus the shared time clock at `/timeclock`. See
   [Staff: scheduling and time clock](#staff-scheduling-and-time-clock) below.

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

### Staff: scheduling and time clock

Employees are not operators. They never sign in to the admin. Each one gets
a 4 to 6 digit PIN for the shared time clock, and the PIN is stored hashed
(HMAC-SHA256 keyed by `SESSION_SECRET`), so it is shown only once.

**Manager side (`/admin/staff`).**

| Tab | What it does |
|---|---|
| Overview | Who is on the clock now (with a manager clock-out that needs a reason), late and no-show shifts, today's labor cost against today's sales as labor %, this week's worked against scheduled hours, overtime risk, and counts that need attention. Refreshes every 30 seconds. |
| Schedule | A week grid with one row per active employee plus open shifts. Shift chips show draft or published state and conflicts: overlap, approved or requested time off, outside availability, overtime. **Copy last week** adds drafts and skips shifts already there. **Publish** makes the week's drafts visible to staff. Footer rows show hours, labor cost, forecast sales (the same weekday's average over the previous four weeks) and projected labor %. |
| Timesheets | Per employee: daily paid hours, regular, overtime and double-time hours, tips, estimated gross, flags and approval. Expand a row to edit or delete a punch, or add a missed one. Every change needs a reason and is kept in an audit log under the punch. Editing an approved punch clears the approval. **Export CSV** downloads the payroll file. |
| Employees | Contact details, roles with a rate for each, a primary role, weekly availability and the PIN. Archive someone who leaves: their history stays, they drop off the schedule and the clock, and their upcoming shifts become open shifts. |
| Time off | Pending requests with the shifts they conflict with, approve or deny, and time off entered on someone's behalf (approved at once). |

Store rules live in **Settings → Staff & payroll**: the store timezone, the
payroll week start, weekly overtime (40 h), optional daily overtime and double
time (California: 8 h and 12 h), the no-meal-break flag, the late and
early-out grace, and an optional block on clocking in early.

**Payroll rules.** Each punch counts toward the store-local day it started on,
so an overnight close belongs to the day it opened. Paid minutes are the
punch minus unpaid breaks, in whole minutes with no rounding to the quarter
hour. Daily overtime comes first, then weekly overtime converts only regular
minutes past the weekly threshold. Someone who works two rates in a week gets
overtime at the FLSA weighted-average regular rate. Open punches count up to
now on screen but are left out of the CSV.

**Time clock (`/timeclock`).** Open it on a tablet signed in as an operator,
as with the kitchen display. Staff then:

1. Enter their PIN on the pad (a keyboard works too).
2. Clock in. The role defaults to the scheduled shift's role, then to their
   primary role. Someone with more than one role can pick another.
3. Start a meal break (unpaid) or a rest break (paid), and end it. Clocking
   out is offered only after the break ends.
4. Clock out, optionally declaring cash tips, and see the shift summary.
5. Check today's shift, the next 7 days of published shifts and this week's
   hours, and request time off.

The screen returns to the PIN pad 20 seconds after the last touch, and 4
seconds after each confirmation. The tablet never holds an employee session:
the PIN is sent with every request. A double tap or a second tablet can't
open two punches, because the database allows one open punch per employee.

#### Deploying the staff schema

The staff tables and settings columns are additive, so migrate before
deploying this code:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push   # new enums and tables, settings columns with defaults
```

Then open **Settings → Staff & payroll** and set the store timezone. It
defaults to America/Chicago, and every shift, day and payroll week uses it.

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
  (subtotal, tax, delivery fee, tip, total) and `payment_status`
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
                 kds.ts (kitchen display rules, pure), kds-server.ts (queries + actions),
                 zoned.ts (store-timezone calendar math), timeclock.ts (staff rules and
                 payroll math, pure), timeclock-server.ts (staff queries + actions)
  app/(store)/   customer storefront (menu, cart, checkout, order status)
  app/admin/     operator dashboard (orders, menu, modifiers, settings, team, staff)
  app/kitchen/   kitchen display (KDS); data via app/api/kds
  app/timeclock/ staff time clock kiosk; data via app/api/timeclock
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
8. **Coupons/promo codes; printable kitchen tickets**
9. **KDS follow-ups** (from `docs/kds-research.md`): half-and-half pizzas end
   to end (ordering, pricing and a left/right ticket layout, the most-requested
   pizza KDS feature); a kitchen-only role so the display tablet doesn't carry
   full admin access; promised-time sorting once scheduled orders exist
10. **Staff follow-ups**: tip pooling
    ([#5](https://github.com/southouterspace/minks-pizza/issues/5)), shift swaps
    between staff ([#6](https://github.com/southouterspace/minks-pizza/issues/6)),
    PIN lockout and manager reset
    ([#7](https://github.com/southouterspace/minks-pizza/issues/7)), payroll
    provider export (Gusto, ADP), SMS shift notifications

See `NOTES.md` for the build log and decision record.
