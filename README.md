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
9. **Staff** (`/admin/staff`) — employees, the weekly schedule, timesheets and
   time off, plus the shared time clock at `/timeclock`. See
   [Staff: scheduling and time clock](#staff-scheduling-and-time-clock) below.

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
the board numbers and history dates, the clock that promised times are
shown in, and the day rewards promotions and birthdays fall on. Default:
Central.

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

#### Inventory and food cost

**Toppings by half and portion.** A modifier group's kind (Modifiers page)
decides how it behaves: **Size** picks which recipe quantities apply,
**Toppings** lets customers put each topping on the whole pizza or one half
and choose light, regular or extra. A half topping costs the share of its
price set in Settings (50% by default); extra is offered only on toppings that
have an extra price. The server reprices every choice at checkout, and the
order line records which modifier, which half and how much, so the kitchen
display groups toppings under WHOLE, L and R.

**Ingredients and recipes** (`/admin/inventory/ingredients`, item editor,
Modifiers page). An ingredient has a base unit (grams, millilitres or each),
a cost entered per any purchase unit or custom pack ("case of 4 × 5 lb"), a
storage area and shelf order, and optional low-stock and 86 thresholds. Items
and topping modifiers carry a recipe per size; a size column overrides "All
sizes". Halves and portions scale a topping's quantity by the factors in
Settings (half 50%, light 50%, extra 150% by default). A negative quantity on
an option ("No onions") removes that much from the pizza. The item editor
shows plate cost and margin for each size.

**The stock ledger.** Every change to stock is an appended
`inventory_moves` row: a sale, a delivery, waste or a count. On hand is the
sum; nothing is overwritten. A completed order holds its recipe usage, and any
other status holds none. Every status change brings the order's sale moves in
line in the same database transaction, so the kitchen display's recall gives
the stock back and completing again takes it once. Each order line keeps its
food cost from the moment it completed.

**Counts, waste and deliveries** (`/admin/inventory`). Full counts run by
storage area in shelf order; a spot count lists the five ingredients with the
most sales dollars in the last 7 days. Each entry is saved on the device as
it's typed. A count posts counted minus on hand, so the count itself is the
variance since the last one. Deliveries update each ingredient's cost and warn
when it moved more than 5% from the last delivery.

**Auto-86.** Once an ingredient has been received or counted, falling to its
86 threshold turns off every item and option whose recipe uses it, notes it on
the order that crossed it, and shows a red banner across the admin. Turning an
item back on by hand sticks. A delivery or count that lifts the stock above
the threshold turns back on exactly what inventory turned off.

**Reports** (`/admin/reports`). Food cost % by day, actual vs theoretical
usage for any count (largest cost first, so mozzarella usually leads), topping
mix by size (attach rate, halves, light and extra), and margin by item and
size, flagged below the minimum margin in Settings. Each exports to CSV.

##### Deploying the inventory schema

Additive: new enums and tables, nullable or defaulted columns on
`modifier_groups`, `modifiers`, `order_items` and `store_settings`. Migrate
before deploying the code, then mark the size and topping groups:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push
```

```sql
update modifier_groups set kind = 'size'     where name ilike 'size%';
update modifier_groups set kind = 'toppings' where name ilike '%topping%';
```

`npx tsx --env-file=<env file> scripts/seed-inventory.ts` adds a starter set of
ingredients and per-size recipes for the seeded menu. It is idempotent and
sets no 86 thresholds. Orders placed before the migration have no modifier
ids, so they render as before and are never depleted.

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

### Front-of-house POS (`/pos`)

`/pos` is a full-screen, touch-first counter screen for walk-in, phone and
some dine-in orders, on a tablet or a 1366×768 laptop. It shares one order
seam with the storefront and the KDS. Like `/kitchen`, the device signs in as
an operator; staff then unlock it with their PIN (4 to 6 digits, the same PIN as the time clock), and it locks again
after `store_settings.pos_lock_seconds` of idle time (or after each order, a
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
- **Scheduling.** Phone and delivery orders go ASAP or Later. Later takes a
  ready time on the store's clock and fires the order to the kitchen that
  many quote minutes earlier; until then it is `held` and off the KDS.
  Dine-in checks can be sent or held and fired line by line.
- **Paying.** Cash (exact, $20, $50, $100 or any amount, with change due),
  card on the separate terminal (amount, tip, optional last 4), several
  tenders in a row, or pay later. A check splits 2 to 4 ways evenly, or by
  item: tap which guests had each line, and a line nobody is tapped on (one
  pizza for the table) is shared by everyone. Shares come from `allocate`,
  so they are deterministic and sum to the cent. Split by item on the order
  instead moves whole lines to a new check on the same kitchen ticket.
- **Open orders.** Every open order across channels, searchable by name,
  phone or number, with lanes for held, in kitchen, ready and unpaid. An
  order opens to collect payment, add to a dine-in check, fire held lines,
  void, comp, discount, split, refund, cancel, hand off, reprint the
  receipt and read its activity log. `/pos?order=<id>` opens one directly.
- **Shift.** Open with a starting bank; no sale, paid in and paid out from
  the staff menu; close with counted cash, the card batch total and declared
  cash tips, which shows expected vs counted and links to the Z report.
- **Offline.** A new order is saved in the browser (IndexedDB) before it is
  sent. If it can't reach the server it shows as NOT SENT in red, prints a
  paper kitchen ticket, and replays automatically; a replay can't double-ring
  because the order id is minted on the device. See
  [Known limits](#known-limits) for what still needs the connection.

Receipts and fallback tickets print through the browser at 80mm width.

**Rules the server enforces.**

- **Staff and PINs.** A PIN switch sets a short `minks_staff` cookie. PINs
  are stored as `HMAC-SHA256(SESSION_SECRET, "pin:" + pin)` in hex, so rotating
  `SESSION_SECRET` means re-setting every PIN. Five wrong PINs in five
  minutes lock the device for the rest of the window. Staff, their PINs and
  who may use the POS are managed under **Staff → Employees** (`pos_access`:
  none, cashier or manager; a job role is separate). `npm run db:seed` adds
  Morgan Manager (PIN 1234) and Casey Cashier (PIN 5678).
- **Manager approval.** Voiding a line already sent to the kitchen, comps,
  discounts over `discount_approval_cents`, refunds, no-sale, paid-out and
  shift close need a manager. The server checks at the moment of the action;
  a cashier gets `needs_manager`, the terminal pops a manager PIN pad and
  resends the same request with the manager's PIN. Who acted and who
  approved are stored on the fact row.
- **Money.** Tenders (cash, card on the external terminal, other, or the
  marketplace that collected it), refunds, and the discount rows in
  `order_discounts` (deals, rewards and staff comps) are rows. `orders.subtotal/discount/tax/total/paid/
  refunded_cents` are folds over them, written only by the fold statement
  that ends every write; payment state (`unpaid / partial / paid / refunded`)
  is derived, never stored. Tax uses `orders.tax_rate_bps`, the store rate
  snapshotted when the order was placed, so changing the store rate never
  re-taxes an older order that is paid or edited later. A marketplace order
  keeps the totals its platform sent; only its payments fold. Once anything
  has been paid, discounts and comps are locked: money goes back as a refund.
- **Halves.** Each topping on a line carries `placement` (whole, left,
  right) and `amount` (regular, extra, light, none). Placement is allowed
  only in sauce, cheese and topping groups (`modifier_groups.role`). The
  half rule is `store_settings.half_topping_rule`: `average` (also what
  "half price per half topping" works out to) or `highest`. A Large Cheese
  ($16.99) with Pepperoni ($1.75) on the left and Mushrooms ($1.50) on the
  right is $18.62 under `average` and $18.74 under `highest`.
- **Scheduled and held orders.** An order with a fire time is `held` and
  stays off the KDS until a KDS or POS board poll fires it. Kitchen status
  is derived from the line stamps (fired, in the oven, done) by the fold
  that ends every write, and each move it makes is logged to `order_events`
  with who caused it: the customer, the scheduler, the kitchen display's
  operator, or the employee at the till and the manager who approved.
- **Replays.** Every POS write carries client-minted UUIDs and is one
  convergent `db.batch`, so a retried submit, tender or void lands once.

Wire API: `POST /api/pos/orders` (the replayable submit), `GET
/api/pos/menu`, `GET /api/pos/customers?phone=`, `GET /api/pos/board`; the
interactive verbs are server actions in `src/app/pos/actions.ts`.

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

#### Promotions and rewards together

A member's reward stacks with deals. Deals apply first, and the reward comes
off what is left of the items, never more. Tax is on the items after both,
and points are earned on that amount. The reward is an `order_discounts` row
with source `loyalty`. It never counts as a use of a deal, and staff can't
remove it from the order page.

### Rewards (`/rewards`, `/admin/loyalty`)

A points program the operator turns on in **Loyalty**. It is off until then.
Research behind the defaults is in `docs/loyalty-research.md`, and the
customer complaints it answers are in `docs/loyalty-complaints.md`.

- **Earning.** 10 points per $1 of food and drink after any reward discount.
  Tax, tip and the delivery fee don't earn. Points post when the order is
  completed and are shown as Pending until then. Guests join by phone with a
  checkbox at checkout, with no sign-in needed to earn.
- **Spending.** Signed-in members pick a reward at checkout ($3 off at 300,
  a free side at 700, a free large pizza at 1,500 by default). Totals come
  from the server. A cancel returns the points.
- **Sign-in.** A 6-digit code texted to the phone, with no passwords.
  **Production needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
  `TWILIO_FROM_NUMBER`**. Without them, customers still earn but can't sign
  in to spend, and the admin shows a warning. In development the code is
  shown on screen.
- **Bonuses.** Welcome bonus on the first completed order of $15+, a
  birthday bonus, referral bonuses for both sides, and promotions such as
  double points on Tuesdays. Welcome and referral bonuses post with the
  completion that earns them. A referrer already paid for 10 friends in the
  last year gets nothing for the next one, then or later.
- **Trust rules.** A raised reward price keeps the old price for 60 days.
  Points expire only after 12 months with no completed order, and the
  rewards page shows the date. Balances never go below zero. Signing in
  claims the member's phone-matched orders from the last 30 days. Members can
  delete their account.
- **Operators.** Members search, ledger, point adjustments with a reason,
  restore of expired points, a missing-order claim, rewards and promotions
  editors, tiers and program settings.

Every balance change is one SQL statement that appends to `loyalty_ledger`
and moves the cached balance together (`ledgerStatement` in
`src/lib/loyalty-server.ts`). Each entry has a unique idempotency key, so
replays do nothing, and a `CHECK (points_balance >= 0)` makes overspending
fail the whole order transaction. `npm run loyalty:audit` confirms every
balance and lifetime total matches the ledger, and `npm run e2e:loyalty`
runs the end-to-end scenarios against a dev server on a test database.

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

### Customer (`/`)

Menu browsing with category navigation → item customization dialog (sizes,
crusts, toppings with live price updates, quantity, special instructions) →
cart (persisted in localStorage) → checkout (pickup/delivery, contact details,
address for delivery, tip presets, order notes) → order confirmation page with
a live status tracker.

All pricing is authoritative server-side: the cart submits only item/modifier
ids, and the server re-validates availability, modifier rules, delivery
minimums, and recomputes every price at order time.

## Deploying

Every schema change is additive except where a dated file in `migrations/`
says otherwise. The rule for a production release: run the SQL file named
below for the release, then `npm run db:push` for everything additive, then
deploy the code. `npm run db:migrate -- <file>` runs one SQL file over Neon's
HTTP driver (`scripts/run-migration.ts`), so it works where `psql` cannot
reach the database; each file is one idempotent `DO` block and running it
twice is a no-op.

### This release: front-of-house POS

```bash
MINKS_DATABASE_URL=<production url> npm run db:migrate -- migrations/2026-10-03-pos.sql
MINKS_DATABASE_URL=<production url> npm run db:push      # prints "No changes detected" once the file has run
MINKS_DATABASE_URL=<production url> npm run db:seed      # optional: adds the demo POS staff on a store with none
```

What the file does to a database at the promotions schema:

- `order_status` loses `confirmed` (existing rows and audit rows become
  `new`) and gains `held`; `order_type` gains `dine_in`; `order_source` gains
  `walk_in` and `phone`.
- `payment_status` and `payment_method` go away. Each order recorded as paid
  becomes one payment tender for its total (card → `card_external`), dated
  by its "payment recorded" event, and `orders.paid_cents` is set to match.
  The file refuses to run while an order is `refunded`, because there is no
  refund amount on record to convert; record that refund as a tender first.
- New: `tenders`, `drawer_sessions`, `drawer_events`, `customers` (backfilled
  from every phone on an order), `customer_addresses`, `pin_attempts`;
  `employees.pos_access` (backfilled: manager or shift lead → manager,
  cashier → cashier, else none); `orders.tax_rate_bps` (backfilled from each
  order's own tax); `order_items.line_uid`, `fired_at` (backfilled to the
  placed time) and the void columns; old modifier snapshots gain their kind,
  role and id; `order_events` and `order_discounts` gain the POS actor
  columns; the POS settings columns with their defaults.

Rehearsed on a branch of production: orders, items, events, employees,
loyalty, promotions and time-clock row counts are unchanged, order totals
are unchanged, and a second run plus `db:push` report nothing to do.

### Earlier releases, in order

Each of these is already applied to production; they are listed so a fresh
database restored from an older backup can be brought forward.

1. **Order management, KDS, rewards, staff**: additive, `npm run db:push`.
   A database that ran an early build of the rewards branch has `referral`
   ledger rows and restores stored as `adjust`; convert those by
   idempotency-key prefix (`referral:referrer:` to `referrer_bonus`,
   `referral:referee:` to `referee_bonus`, `restore:` to `restore`) before
   pushing, recompute `lifetime_points`, and check with `npm run loyalty:audit`.
   After the KDS push, route the categories once (or do it in Menu → Edit):

   ```sql
   update categories set station = 'pizza'   where name ilike '%pizza%' or name ilike 'build your own%';
   update categories set station = 'counter' where name ilike '%drink%' or name ilike '%beverage%';
   ```

   Then open **Settings → Staff & payroll** and set the store timezone.
2. **Promotions**: `migrations/2026-10-03-promotions.sql` (plain DDL plus a
   backfill: each earlier order with a reward discount gets a `loyalty` row
   in `order_discounts`). After a plain `db:push` instead, run that file's
   last statement once.
3. **Delivery integrations** (#12): additive, `npm run db:push`: three enums,
   `orders.source`, `source_order_id` and `source_display_id`, and the
   `courier_deliveries` and `integration_events` tables. Orders placed
   before it read as `web`.

## Tests

Each script's header says what it covers and what it expects. The `e2e-*`
scripts drive a running `npm run dev` (port 3000, or set `E2E_BASE_URL`) and
mutate the database in `.env.local`, so point it at a test branch and run
them one at a time. They share `scripts/e2e/harness.ts`: `check(label,
actual, expected)` against a literal, `eventually`, operator sign-in, the
menu fixtures, `moveOrder` (the kitchen's stamps through the fold) and the
exit code.

```bash
npx tsc --noEmit && npm run lint && npm run build
npm test                 # test:unit then test:domain
npm run test:unit        # node:test suites (delivery adapters, loyalty, marketplace) + the pure scripts:
                         # test-pos-client, test-order-workflow, test-promotions, test-timeclock
npm run test:domain      # test-pos-domain: pricing, folds, approvals, splits, reports; uses .env.local
npx tsx --env-file=.env.local scripts/e2e-pos.ts           # every terminal flow
npx tsx --env-file=.env.local scripts/e2e-pos-api.ts
npx tsx --env-file=.env.local scripts/e2e-kds.ts
npx tsx --env-file=.env.local scripts/e2e-backoffice.ts    # settings, staff, reports, inbox
npx tsx --env-file=.env.local scripts/e2e-orders.ts        # board, history, detail, KDS recall
npx tsx --env-file=.env.local scripts/e2e-promotions.ts
npx tsx --env-file=.env.local scripts/e2e-timeclock.ts
npm run e2e:loyalty
npx tsx --env-file=.env.local scripts/e2e-operator.ts     # also e2e-customer, e2e-team, e2e-logo
```

## Known limits

- **Offline is partial.** A new POS order survives a dropped connection and
  replays, but the KDS needs the internet, so the printed paper ticket is the
  kitchen's copy until it returns. Payments and changes to existing orders
  need the connection too.
- **No offline menu cache.** The terminal keeps the menu in memory, not in
  IndexedDB. A terminal reloaded while offline has no menu.
- **Storefront toppings are whole only.** Halves, extra and light are rung
  in at the counter; the online cart sends whole, regular toppings.
- **POS orders earn no points and get no deals.** Deals and rewards apply at
  the online checkout; a phone number on a counter order creates the CRM
  record only. Points promised at checkout are not adjusted by a later void
  or comp at the till.
- **No email.** There is no end-of-day report email and no customer email;
  reports are on screen, printed or exported as CSV.

## Stripe readiness

- Money is integer cents everywhere; `orders` carries a full breakdown
  (subtotal, discount, tax, delivery fee, tip, total) and `payment_status`
  (`pending`/`paid`/`refunded`).
- `src/lib/orders.ts` → `createOrder()` is the single seam: create a
  PaymentIntent for `totalCents` there, store its id, and flip
  `payment_status` from a Stripe webhook. `placeOrder` in
  `src/app/(store)/actions.ts` already returns a structured result to which a
  client secret can be added.

## Delivery integrations

The store can send a courier to a delivery order placed on our site. Uber
Direct is the production path. DoorDash Drive works in its sandbox only,
because DoorDash has closed production access. Orders placed on the
marketplaces themselves still arrive on their tablets. The schema and
`src/lib/marketplace.ts` are ready for them, but each marketplace API needs a
partner agreement first. See `docs/delivery-platforms-research.md` for the
API details and the reasoning.

The schema for this feature is additive (see [Deploying](#deploying)).

A provider appears in the orders inbox only when all of its required variables
are set. Each active web delivery order then gets a "Request courier" button,
and a live courier shows its status, fee, driver and tracking link with a
"Cancel courier" button. The customer's order page shows the courier status
and a tracking link while a courier is on the way.

| Variable | Purpose |
|---|---|
| `UBER_DIRECT_CUSTOMER_ID` | Customer ID from the direct.uber.com Developer tab |
| `UBER_DIRECT_CLIENT_ID` | OAuth client ID |
| `UBER_DIRECT_CLIENT_SECRET` | OAuth client secret |
| `UBER_DIRECT_WEBHOOK_SIGNING_KEY` | The signing key shown when you create the webhook. It is not the client secret. |
| `UBER_DIRECT_TOKEN_URL` | Optional. Defaults to `https://auth.uber.com/oauth/v2/token`. |
| `UBER_DIRECT_SANDBOX` | Set to `1` to have Uber's robo courier drive each delivery |
| `DOORDASH_DRIVE_DEVELOPER_ID` | Developer ID from the DoorDash developer portal |
| `DOORDASH_DRIVE_KEY_ID` | Access key ID |
| `DOORDASH_DRIVE_SIGNING_SECRET` | Access key signing secret, base64 as the portal shows it |
| `DOORDASH_DRIVE_WEBHOOK_AUTH` | The exact `Authorization` header value you configure for webhooks in the portal |

Point each provider's status webhook at:

- `https://<your domain>/api/webhooks/couriers/uber_direct`
- `https://<your domain>/api/webhooks/couriers/doordash_drive`

The endpoint records each event in `integration_events` before applying it,
so provider retries are harmless. A failed event keeps its error on that row.
`npm test` runs the adapter and domain unit tests.

## Project layout

```
src/
  db/            schema.ts (Drizzle), seed.ts, index.ts (client)
  lib/           menu.ts, orders.ts (pricing + the guarded order insert), auth.ts,
                 validation.ts, checkout.ts (one quote: promotions + loyalty; createOrder),
                 order-workflow.ts (order lifecycle rules, pure),
                 order-writes.ts (logged status/ETA/payment/note writes),
                 order-queries.ts (board, history search, export, detail, day stats),
                 promotion-engine.ts (reward union and best-deal evaluator, pure),
                 promotion-queries.ts (candidates and usage from the ledger),
                 promotion-admin.ts (operator list, stats, codes),
                 loyalty.ts (program rules, pure), loyalty-server.ts (ledger + queries),
                 kds.ts (kitchen display rules, pure), kds-server.ts (queries + actions),
                 units.ts, unit-entry.ts, toppings.ts, recipes.ts (inventory rules, pure),
                 inventory.ts (stock ledger, counts, deliveries, auto-86),
                 inventory-reports.ts (food cost, variance, topping mix, margins),
                 zoned.ts (store-timezone calendar math), timeclock.ts (staff rules and
                 payroll math, pure), delivery/ (courier providers and dispatch),
                 marketplace.ts (marketplace order seam)
  lib/staff/     staff server modules, one per feature: config, queries, employees,
                 kiosk, schedule, time-off, timesheets, overview; timesheet-csv.ts (pure)
  app/(store)/   customer storefront (menu, cart, checkout, order status, rewards)
  app/admin/     operator dashboard (orders board, history + detail, menu,
                 modifiers, inventory, reports, promotions, loyalty, settings, team,
                 staff); CSV exports in app/api/admin
  app/kitchen/   kitchen display (KDS); data via app/api/kds
  app/timeclock/ staff time clock kiosk; data via app/api/timeclock
  components/    cart context, storefront + admin UI
```

## Roadmap

Informed by industry research (see `docs/RESEARCH.md`), roughly in order:

1. **Stripe payment capture** — the seam is ready (see above)
2. **Scheduled orders** (ASAP vs later) and rush-aware prep-time estimates
3. **SMS status notifications** — cuts "where's my order" calls
4. **Delivery zones** (radius/ZIP validation, tiered fees)
5. **Allergen/dietary tags & item photos** (schema already has `imageUrl`)
6. **Customer accounts with saved addresses & one-tap reorder** — optional,
   post-purchase (guest checkout stays the default)
7. **Refunds** (the `refunded` payment status exists but nothing sets it
   yet; the stock ledger already treats a refunded order as using nothing, so
   a refund action only needs to batch the same inventory sync that status
   changes do). Promotions shipped (see [Promotions](#promotions)); follow-ups:
   customer identity beyond the phone number once accounts or Stripe card
   fingerprints exist, a redemption velocity alert for leaked codes, and an
   audit log of deal edits
8. **KDS follow-ups** (from `docs/kds-research.md`): a kitchen-only role so
   the display tablet doesn't carry full admin access; promised-time sorting
   once scheduled orders exist
9. **Staff follow-ups**: tip pooling
   ([#5](https://github.com/southouterspace/minks-pizza/issues/5)), shift swaps
   between staff ([#6](https://github.com/southouterspace/minks-pizza/issues/6)),
   PIN lockout and manager reset
   ([#7](https://github.com/southouterspace/minks-pizza/issues/7)), payroll
   provider export (Gusto, ADP), SMS shift notifications

See `NOTES.md` for the build log and decision record.
