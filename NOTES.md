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
- [x] Drizzle schema + migration pushed to Neon
- [x] Seed script (demo menu: classic pizzeria categories/items/modifiers)
- [x] Operator auth lib (bcrypt + jose sessions)
- [x] Admin dashboard (built by subagent: setup/login, orders inbox with legal
  status transitions, menu CRUD with 86-toggle/reorder, modifier groups with
  radio-default semantics, settings with publish + pause switches)
- [x] Storefront: menu, item customization dialog, cart (localStorage)
- [x] Checkout: details + validation + order creation (Stripe-ready seam)
- [x] Order confirmation/status page with live polling
- [x] Order pipeline test: pricing exact (subtotal 4048¢ case), missing-required-modifier and delivery-minimum rejections verified against live DB
- [x] README
- [x] Admin flow review (auth coverage: 22 requireOperator calls across
  protected actions; legal status-transition map verified) + tsc + eslint clean
- [x] Operator e2e (Playwright): first-run setup → orders inbox → confirm order
  → menu page → settings → **publish via UI switch → storefront went live** →
  sign out → re-login. PASSED
- [x] Customer e2e re-verified on the published store; mobile (375px)
  screenshots verified (bottom-sheet dialog works well)
- [x] Production build passes; prod server smoke-tested (all routes 200)
- [x] Handoff state reset: operators table emptied, is_published=false —
  owner gets the pristine /admin/setup → build menu → publish journey.
  Demo orders #1001–#1002 left in the inbox intentionally.
- [x] Final push

## Session 2 — shadcn/ui migration, address change, deployment

- **Address**: store moved to 30340 FM-2978, The Woodlands, TX 77354 (live DB +
  `seed.ts`). Tax rate followed it: 0 bps (Oregon) → **825 bps** (TX 6.25% state
  + 2% local). Operator can change it in Settings.
- **Deployment**: Vercel project `minks-pizza`
  (`prj_9P5LKTI8efRgnDcEBXKCSFoXunHt`, team `south-outer-spaces-projects`)
  linked to the GitHub repo with production branch
  `claude/spin-up-say-hi-faiohe`. Vercel Authentication (SSO protection) was
  ON for all deployments — turned OFF, since customers must reach the
  storefront anonymously. Deploys happen on push.
  - `src/db/index.ts` now builds the Drizzle client **lazily** behind a Proxy so
    a build without `DATABASE_URL` can't fail at import time.
  - The sandbox proxy blocks `*.vercel.app`, so the live URL can't be verified
    from this session — check it in a browser.

### shadcn/ui — Base UI variant, Nova preset

The CLI (`npx shadcn init -b base -p nova`) could not run: this sandbox's proxy
returns 403 for `ui.shadcn.com`. Components were **vendored manually** from the
upstream repo instead, which is exactly what the CLI does anyway:

1. `git clone --depth 1 --filter=blob:none --sparse https://github.com/shadcn-ui/ui`
   → `apps/v4/registry/bases/base/ui/*.tsx` (Base UI variant).
2. Copied into `src/components/ui/`, rewriting `@/registry/bases/base/...`
   imports to `@/lib/utils` and `@/components/ui/...`.
3. The registry ships `<IconPlaceholder lucide="XIcon" tabler=… />` shims that
   the CLI swaps for the chosen icon set; a script replaced each with its real
   Lucide icon + import (`scratchpad/fix-icons.py`).
4. Theme: `src/app/globals.css` imports `tailwindcss`, `tw-animate-css`,
   `shadcn/tailwind.css` and `src/styles/style-nova.css`, then the upstream
   neutral token blocks. `--success`/`--warning` are appended as app-specific
   extras (shadcn has no such tokens).
5. The Nova component classes are scoped under `.style-nova`, so `<html>`
   carries that class; `next/font` now binds Geist to `--font-sans`/`--font-mono`
   because that's what the shadcn theme reads.
6. `components.json` records the setup (`base: "base"`, `style: "nova"`) so the
   CLI can add more components later — from a network that allows the registry.

**Token meanings changed** (the trap in this migration): shadcn's `muted` is a
near-white *background* (old code used `text-muted` for secondary text → became
invisible) and `accent` is a light-gray hover surface, not the brand black.
Migration map applied across the app: `text-muted`→`text-muted-foreground`,
`text-faint`→`text-muted-foreground`, `bg-surface`→`bg-muted`,
`bg-accent`/`text-accent-foreground`→`bg-primary`/`text-primary-foreground` (or
a real `<Button>`), `text-error`→`text-destructive`, `text-link`→`text-primary`.

### Store logo (session 2)

Stored in Neon as a real asset, not inlined. The first cut downscaled the image
to a `data:` URL inside `store_settings` and capped it at 400 KB — which a
detailed crest logo blew straight past, and which would have dragged the image
bytes into every storefront page query.

Current design:

- `store_logo` — its own table (id = 1, `content_type`, base64 `data`,
  `byte_size`). Separate from `store_settings` so page renders never read the
  bytes. Base64 text rather than `bytea` keeps the serverless HTTP driver on
  plain text.
- `store_settings.logo_uploaded_at` — set when an upload exists; doubles as the
  cache-busting version. `logo_url` still holds an externally hosted https URL.
- `POST/DELETE /api/admin/logo` — operator-authed multipart upload (4 MB cap,
  under Vercel's ~4.5 MB request-body limit), so uploads bypass the server
  action body limit entirely. Uploading clears `logo_url`; saving a pasted URL
  deletes the upload, so exactly one logo wins.
- `GET /api/logo` — serves the bytes with `immutable` caching + ETag; callers
  append `?v=<logo_uploaded_at>`.
- `resolveLogoSrc()` in `src/components/store-mark.tsx` picks upload → URL →
  initial-badge fallback. The logo renders at its **natural shape** (no
  rounding or cropping) so crests and wordmarks aren't clipped into a circle;
  only the fallback initial is round.

Neon was chosen over Cloudflare R2 deliberately: R2 would need a bucket plus
access keys added to Vercel's env, whereas the database is already wired into
production, so this needs no new credentials or configuration.

### Bug fixed: cart wiped on page refresh

`cart-context.tsx` gated its persist effect on a `useRef` that was flipped
synchronously inside the hydrate effect. Both effects run in the same commit,
so the persist effect saw `hydrated.current === true` while `lines` was still
`[]` and wrote the empty cart back over the saved one (guaranteed under
StrictMode; a race in production). It now gates on the `ready` **state**, which
can't be true until the render that carries the restored lines. Client-side
navigation hid this from the e2e — only a hard refresh reproduced it.

## Session 3 — Team management (multi-operator)

**Ask:** "How does a new user sign up for admin access?" → there was no answer.
`/admin/setup` creates the first operator then locks itself forever, and it was
the *only* code path that ever inserted into `operators`. So a second admin was
impossible without a manual SQL write.

**Built:** `/admin/team` — list operators, add one, remove one, change your own
password.

- `addOperator` / `removeOperator` / `changeOwnPassword` in
  `src/app/admin/actions.ts`, all behind `requireOperator()`.
- `setupSchema` became the shared `operatorSchema`, and the min-8 rule became
  `passwordSchema`, so first-run setup and Team validate identically.

**Design decisions and why:**

- **No self-removal.** This is the load-bearing invariant, not a UX nicety: you
  can only delete an account that isn't yours, so the count can never reach
  zero. At zero, `operatorExists()` flips false, `/admin/setup` unlocks, and
  anyone on the internet can claim the store. A separate "don't delete the last
  operator" check would be redundant — the self-check already implies it.
- **No roles.** Every operator gets full access. Documented loudly in the UI and
  README rather than half-implemented.
- **Creator sets an initial password**, rendered as `type="text"` so it can be
  read aloud/copied to hand over. That means the creator knows it — which is why
  "Change your password" ships in the same screen. Without it the feature would
  be unsound. Email invites were rejected for v1: they need a verified Resend
  domain and a token table.
- **Duplicate email** is caught two ways: a friendly message from the caught
  insert (the unique index on `email` is the only constraint it can trip), and
  emails lowercased on the way in to match how `loginOperator` looks them up.
  `redirect()` is called *outside* the try — it signals by throwing, so a
  `catch` would swallow it.

**Tested:** `scripts/e2e-team.ts`, 12 assertions — add, duplicate rejection
(including case-insensitivity), sign-in as the new operator, wrong-current-
password rejection, password change, sign-in with the new password, removal,
and the removed account no longer authenticating.

## Session 4 — Kitchen display system

**Ask:** research what operators love and hate about Toast KDS, Square KDS and
their competitors (pizzerias first), then ship a working KDS.

**Research** (`docs/kds-research.md`, delegated to a subagent): the biggest
pizza gaps are half-and-half display, the make-line → oven handoff, dropped
tickets and offline failures, hard-to-read modifiers, and all-day counts that
can't count by size. Reddit, Toast Community and most review sites were
unreachable from the sandbox. Sources and paraphrases are marked in the
report.

**Built:** `/kitchen` (see README → Kitchen display).

- **Data model.** `categories.station` (pizza / kitchen / counter) is copied
  to `order_items.station` at checkout. Each item records progress in
  `order_items.oven_at` and `done_at`, the order in `orders.ready_at`, and
  the timer thresholds and oven time live in `store_settings.kds_*`. Order
  status is derived from the items in `syncStatus` (`src/lib/kds-server.ts`),
  so no screen can leave an order "ready" with unmade food.
- **The oven is a stage, not a station.** Pies move queued → oven → done, and
  the Make line and Oven screens are two views over the pizza station. This
  is the handoff Square told a pizzeria it couldn't build.
- **Rules are pure** (`src/lib/kds.ts`): routing, tap/bump transitions,
  ticket layout, all-day counts, and `applyLocally`, which mirrors the server
  so taps feel instant. A poll that started before an action finished is
  dropped, so the screen never flickers back.
- **Recall clears item progress.** A recalled ticket is usually a remake;
  "bumped by mistake" is covered by the Undo toast.
- **No drop channel.** The display reads the orders table directly; there is
  no print or push hop for a ticket to fall out of. A failed tap shows a toast
  instead of failing silently.
- **Not built:** half-and-half needs ordering and pricing support first
  (roadmap #2). The KDS has no role of its own and uses an operator session.

**Tested:** `scripts/e2e-kds.ts`, 27 checks against a throwaway Neon project
(`minks-kds-test`, `autumn-bar-62526195`), because this session's Neon access
couldn't reach the production project. Covered: station snapshot at checkout,
pizza-first ticket layout, all-day counts, make → oven → kitchen → ready →
handoff with database state checked at every step, recall, Undo, bump-bar
keys, a new order appearing live, the cancel alert, and the offline banner
appearing and clearing.

## Session 5 — Order management

**Ask:** Toast-grade admin order management: a live board, history with
search and export, a detail page with an audit trail, promised times, cancel
reasons, payment recording, printing, day stats and a new-order alert.

**Built:** see README → Order management.

- **One lifecycle table.** `src/lib/order-workflow.ts` (pure) owns
  `TRANSITIONS`, `NEXT_ACTION`, `STATUS_META`, `CANCEL_REASONS`, `isLate`,
  `minutesUntil` and `statusTimestamps`. The schema builds its enums from the
  same tuples. The old copies in `admin/actions.ts` and `order-card.tsx` are
  deleted, and the KDS moves status only through it. Cancel is now allowed
  from preparing and ready too (an order can go wrong at any point before
  handoff). KDS recall stays a separate `RECALLABLE` edge, the only way an
  order goes backwards, and `statusTimestamps("preparing")` clears
  `readyAt`/`completedAt` so a recalled order isn't reported as ready.
- **Audit trail in the same statement as the change.** Every write in
  `src/lib/orders-admin.ts` is one data-modifying CTE: lock the order
  `for update` only if the guard (`status in (...)`, `payment_status =
  'pending'`, …) still holds, update it, insert the `order_events` row from
  what the update returned. The brief asked for an update + insert in one
  `db.batch`; a batch can't make the insert depend on whether the update
  matched, and a follow-up insert after `.returning()` could be lost if the
  second request failed. The CTE gives both: no double-apply when two
  tablets (or KDS + admin) tap at once, and never a change without its row.
  `fromStatus` comes from the locked row, so it is exact even for the KDS's
  multi-source moves (`new|confirmed → preparing`). The statements are
  plain `db.execute` items, so the KDS still batches them with its item
  updates in one transaction. Drizzle's insert-select builder can't express
  this (it requires every column including the identity, and duplicates
  nested CTEs), hence the SQL template.
- **The guard is the current status, not the button the operator saw.**
  `transitionOrder` reads the status, checks `canTransition`, then updates
  `where status = <that>`. A stale tap from a second tablet is refused with
  "Order is already confirmed." rather than silently moving the order a
  further step.
- **The store's day.** `store_settings.timezone` (Settings select, US zones).
  "Today" and history date ranges compare `(placed_at at time zone tz)::date`
  in Postgres, which handles DST. Server-rendered times pass the zone
  explicitly; before this, admin timestamps rendered in the server's zone
  (UTC on Vercel).
- **Net sales = item subtotals of non-canceled orders.** Tax, tips and
  delivery fees aren't sales (Toast's definition). Average ticket is net
  sales over those orders. "Late now" is computed with `isLate` over the
  live orders rather than duplicated in SQL.
- **Late means the food is still owed.** `isLate` is true only for
  new/confirmed/preparing past `promisedAt`; a ready order waiting for
  pickup isn't late.
- **Checkout** sets `promisedAt` = placedAt + prep minutes and writes the
  `placed` event (actor "Customer") in the same batch as the order lines.
  Orders from before the migration have neither; the detail timeline shows a
  synthetic "Order placed" for them.
- **New-order alert.** "Seen" is derived, not tracked in an effect: orders
  present on first render are acknowledged, any `new` order not in that set
  is unseen, and a tap or key acknowledges the current ones. The chime plays
  once per order id. The AudioContext is created on the first tap because
  browsers block audio before a gesture; the title flash works either way.
- **Action feedback runs in the submit handler.** The first cut kept the
  result in `useActionState`. A successful move re-renders the board and
  remounts the card in another lane, so that state vanished and the second
  tablet's refusal toast never showed. The e2e caught it.
- **History is a GET form**, so the URL is the state and the CSV link reuses
  the same query. CSV fields are RFC 4180 quoted, and values starting with
  `= + - @` get a leading `'` so a spreadsheet won't run them as formulas.
- **Fixed in passing:** `AutoRefresh` called `router.refresh()` inside a
  `setState` updater (React warned "Cannot update Router while rendering").
- **Not built:** refunds (the status exists, nothing sets it), editing items
  on a placed order, per-operator roles.

**Tested** against a throwaway Neon branch (`ep-purple-unit`):

- `scripts/test-order-workflow.ts`, 7 tests against literal values:
  the full transition table, every legal move and nothing else, `isLate`
  edges, `minutesUntil` rounding, `statusTimestamps` per destination.
- `scripts/e2e-orders.ts`, 60 checks: promised time and placed event at
  checkout; confirm → preparing → ready → complete on the board with the
  database, lanes and one event per move checked; +10 min moves
  `promisedAt` by exactly 600 s; cancel with a reason writes
  `cancelReason`, `canceledAt` and the event, and the tracker shows it;
  the title flashes on an arriving order (not on first load), mute persists
  and a tap acknowledges; two signed-in tablets tap Confirm and it applies
  once with a toast on the second; history search by name, formatted and
  bare phone digits and order number; status filter; CSV export content,
  quoting and 401 when signed out; payment and note events; a KDS recall
  writes a "Kitchen display · …" event and clears the timestamps; the
  timeline lists all of it in order; lanes stack and nothing scrolls
  sideways at 375 px. Screenshots of board, history and detail at desktop
  and 375 px, plus the print ticket.
- `scripts/e2e-kds.ts` still passes (26 checks) with the KDS writing
  through the logged transitions.
- The e2e creates and deletes its own operator. On a database that already
  has operators, `e2e-kds.ts` needs `kitchen@minks.example` to exist.

## Gotchas hit (for future sessions)

- Playwright `getByRole(name:)` is substring-matching: "Publish store" also
  matched the "Unpublish store" switch — use `exact: true`.
- Next dev-tools floating indicator overlapped the admin sidebar footer and
  intercepted e2e clicks → `devIndicators: false` in next.config.ts.
- `create-next-app`'s root `src/app/page.tsx` silently shadows a route-group
  `(store)/page.tsx` for `/`.
- Pre-installed Chromium requires `executablePath: /opt/pw-browsers/chromium`
  (version pin mismatch with the npm playwright package).
- `.env` files are **not** shell scripts. `set -a; . ./.env.e2e` on a Neon URL
  containing `?a=1&b=2` backgrounds the assignment at the `&` and silently drops
  the variable — the app then fell through to `.env.local` (production) and the
  test "failed" for the wrong reason. Quote the values.
- Playwright: `page.locator("div", { has: … }).last()` returns the *innermost*
  matching div, which was a sibling of the button under test — so a
  "no Remove button here" assertion passed vacuously. Anchor row-scoped queries
  to an explicit `data-testid` instead.
- The e2e checks the database right after a tap. The screen updates
  optimistically, so poll the database (`eventually()` in `e2e-kds.ts`)
  instead of reading it once.
- Screenshots taken right after a tab click can catch `transition-colors`
  halfway, so two tabs look selected. Check `aria-pressed`, not pixels.
- Scripts can't import a module with `import "server-only"`: the package
  only exists inside Next's bundler. To call `orders-admin.ts` from tsx,
  point `NODE_PATH` at a directory holding an empty `server-only` package.
- A hydration-mismatch warning about `caret-color: transparent` on the
  history search input showed up only in e2e runs that take screenshots
  (Playwright hides the caret for them). Loading and searching without
  screenshots logs nothing.
- Destructive e2e (creating/removing operator accounts) must not run against the
  production database. `mcp__Neon__create_branch` makes an isolated copy in
  seconds; point `MINKS_DATABASE_URL` at it and delete the branch afterwards.

## Decisions & findings

- 2026-08-12: Container restarted once mid-session; disk survived, background
  agents had to be relaunched. Note: keep commits frequent.
- `.env*` is gitignored by the scaffold — `DATABASE_URL` + `SESSION_SECRET` live in
  `.env.local` (documented in README; `.env.example` committed).
- Money is always integer cents. Tax computed at checkout from
  `store_settings.tax_rate_bps` (basis points) to avoid float drift.
- The sandbox pre-sets a stale ambient `DATABASE_URL` that `.env` files can't
  override → app reads `MINKS_DATABASE_URL` first (`src/db/url.ts`).
- Scaffold's `src/app/page.tsx` shadowed `(store)/page.tsx` for `/` — removed.
- Hours are informational (viewer-local clock, no store TZ column in v1);
  order intake is governed by the operator's publish + pause switches. Server
  enforces: published, accepting, order-type enabled, delivery minimum.
- Test order #1001 exists in the dev DB (useful for admin inbox demo).
- Industry research landed (docs/RESEARCH.md): build validated on guest
  checkout, server-side pricing, modifier architecture, 4-stage tracker.
  Acted on: double-submit guard, recent-order link. Deferred to roadmap:
  half-and-half, per-size topping pricing, SMS, delivery zones, allergens.
- Customer e2e (Playwright, real Chromium): menu → customize (Large/Thin/
  Pepperoni+Mushrooms = $20.24 ✓) → cart → checkout → confirmation #1002 ✓.
- Handoff state plan: after operator e2e passes, delete the test operator row
  and set `is_published=false` so the owner experiences pristine first-run
  setup (/admin/setup → build menu → publish). Demo orders stay for the inbox.
