# Front-of-House POS Research: What Operators Love and Hate

Research date: 2026-10-03. Scope: Toast, Square for Restaurants, Clover, Lightspeed Restaurant, SpotOn, Revel, TouchBistro, Lavu, plus pizza-first POS vendors (HungerRush, formerly Revention; SpeedLine; Slice Register). The use case is a single-location pizzeria counter: walk-in, phone orders, and some dine-in. Pizzeria feedback is prioritized.

**Method and limits.** Pages were read with a fetch tool that returns a model-written extract of each page, so text in quotation marks is what that extract returned as verbatim review text. I could not compare it character by character against the raw HTML. Treat short quotes as reliable and exact punctuation as approximate. Items marked *(paraphrase)* come from search-result summaries or vendor/review-site prose, not from an operator's own words. These pages returned 403 and are **not** cited for specific claims: the Toast Community (including the Pizzeria board), G2 (SpeedLine, HungerRush), and TrustRadius. The Toast Community gap is the largest hole, because it is where pizzeria operators talk most. The SpeedLine Capterra URL I tried served an unrelated product. Reddit was not attempted, because it was blocked for the KDS research. PMQ's most operator-focused POS piece is from 2003. I cite it for a durable pattern, not for current product state. Complaint counts in section 3 are tallies of the distinct sources I read, **not** a statistical sample. Vendor-authored pages are labeled.

Codebase context (read from `src/db/schema.ts`): orders are `pickup | delivery` only, with no dine-in or channel field. Customer data is copied onto each order, and there is no customers table. Modifiers are flat groups with no whole/left/right placement. Staff are email/password `operators` with no PIN or roles. Payment status is `pending | paid | refunded`, with no tender records. The KDS already has make line → oven → done stages.

---

## 1. Per-product loves and hates

### Toast
- **Loves**
  - Caller ID and guest lookup by phone, name or email. Previous orders show in the guest pane, and "Add to order" re-adds a past order's items (vendor docs): https://doc.toasttab.com/doc/platformguide/adminUsingCustomerInformationScreen.html
  - Quote times apply to POS and phone orders, with four strategies: Manual, SmartQuote, Kitchen Capacity, Order Price (vendor docs): https://support.toasttab.com/en/article/Managing-Your-Quote-Time-Strategy
  - Pizza: "offered way more options… square just wasn't as flexible with pizza combinations" (Paulette M., Dec 2022): https://www.softwareadvice.com/retail/toast-pos-profile/reviews/
  - Offline: "you can keep running when the internet goes down" (Linda R., Dec 2022): https://www.capterra.com/p/136301/Toast-POS/reviews/
  - Reporting: "The functionality and reports you get are by far unmatched by anyone" (Trustpilot, Sep 2026): https://www.trustpilot.com/review/toasttab.com
- **Hates**
  - Speed under load: "Toast can slow down, which isn't good when restaurant is busy" (Heather M., Mar 2019); "glitchy and will crash out" (Annalee P., Mar 2025): https://www.softwareadvice.com/retail/toast-pos-profile/reviews/ . "The system itself is as fast as a 1999 MacBook" (Trustpilot, Sep 2026): https://www.trustpilot.com/review/toasttab.com
  - Checks: "can only have one bill open at a time. It makes it challenging for buyouts" (Jackie I., May 2025), same Software Advice URL.
  - 86'd items: "OOS items cannot be sold and do not show price when recalled from the POS station. This is a major drag" (Apr 2026): https://www.capterra.com/p/136301/Toast-POS/reviews/
  - Reporting export: "not able to export order details into excel to use pivot tables" (Chris C., Nov 2025), same Capterra URL.
  - Fees and support: "monthly fees, hidden fees, fees for every single thing add up" (Jessica R., Jun 2025), same Software Advice URL. Trustpilot is 2.8/5 over 1,487 reviews, dominated by support and deposit complaints. Example: "Sometimes the amount settled into your account doesn't match the sales": https://www.trustpilot.com/review/toasttab.com
  - Offline is partial. Online orders do not arrive during an outage (vendor docs, carried over from KDS research): https://support.toasttab.com/en/article/Using-Toast-in-Offline-Mode
  - Half pizzas need H1/H2 modifier workarounds (KDS research, Toast Community, paraphrase): https://community.toasttab.com/t5/pizzeria/half-pizza/m-p/2936

### Square for Restaurants
- **Loves**
  - Cheap to start, no contract (paraphrase, Fit Small Business, updated Jun 2026): https://fitsmallbusiness.com/best-pizza-pos-systems/
  - Customizable options: "It is customizable for you to be able to have different options" (Matthew L., Aug 2026): https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/
  - Cash tip declaration at shift report: "Very very happy to have the new function of servers claiming their cash tips when running their report!" (Aug 2022): https://community.squareup.com/t5/Orders-Menu-Items-Catalog/We-want-to-hear-from-you-about-the-strengths-and-weaknesses-of/m-p/387342
- **Hates**
  - **No half-and-half.** "I don't see how to do the half and half pizza" without notes on every order, then "we charge the highest of the 1/2 but in your scenario, I don't see how that could work" (Oct 2025): https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Square-Restaurants-for-Pizza-location/td-p/820140 . A July 2026 thread asks how to price a half-and-half "that averages the total". The answer is left/right modifier sets plus a $3 fee: https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Half-and-half-pizza/m-p/846835 . "Pizza friendly options such as, 1/2 charges when pizzas are 1/2 pepperoni, 1/2 cheese" (2022): https://community.squareup.com/t5/Orders-Menu-Items-Catalog/We-want-to-hear-from-you-about-the-strengths-and-weaknesses-of/m-p/387342
  - **No phone/to-go flow.** "Merging phone and take out orders with the Orders tab would be a great way to allow restaurants like us to manage ALL to go orders in one place" (Sep 2023). A +1 reply: "I have been requesting this feature since we started": https://community.squareup.com/t5/Feature-Requests/Merge-phone-amp-take-out-orders-with-Orders-tab-on-POS/idi-p/684580 . "Need ability to do a phone order for pickup where the customer will pay cash upon pickup" (2022), 387342 URL above.
  - **Delivery address missing from tickets.** A pizzeria: "the printed ticket (for the kitchen or the driver) does not show the customer's address or phone number" (Mar 2025). The workarounds are a $0 "delivery instructions" item or choosing "Shipment": https://community.squareup.com/t5/Payments-Troubleshooting/Delivery-for-Pizzeria/td-p/783334
  - **Split checks.** "Allow us to split an item on a check. This used to be annoying, now my staff are using it as a way to steal from me" (Feb 2023). Square staff in 2019 said it was "not on our road map right now": https://community.squareup.com/t5/Square-for-Restaurants/Split-a-single-item/idi-p/634697
  - **Permissions regress.** "NOW ALL MY EMPLOYEES CAN DELETE ITEMS… ON AN OPEN TICKET", where before staff "were required to enter my passcode". The fix was reinstalling the app (Apr 2026): https://community.squareup.com/t5/Staff-Payroll/quot-LAST-UPDATE-SQUARE-MESSUP-THE-PERMISSIONS-quot/m-p/840779 . Counter shops want "an employee need to enter their code to delete anything off a check if it is not saved/sent, and for if they open the cash drawer outside of a sale" (Mar 2024): https://community.squareup.com/t5/Feature-Requests/Make-Square-for-restaurants-free-and-plus-better-for-counter/idi-p/714996
  - **Offline.** "If the internet goes down you not only lose the tickets, but the printers won't print" (Donnie M., Nov 2024): https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/ . "Lost power yesterday…Couldn't edit tips or access transactions to close out" (2022), 387342 URL. "Kitchen printers disconnect from the ipads so we need a notification when an item does not send to the kitchen" (2022), same URL.
  - **Switching orders.** "Switching between tickets and to go orders has to be the most frustrating" (Sayda D., Jun 2025). "not set up for tab management" (Angela A., May 2021): https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/
  - **Hold/fire.** An App Store review listing missing features includes "Can't hold items and send when ready for the kitchen" and "No pizza toppings feature" (Feb 2020): https://apps.apple.com/us/app/square-restaurants-pos/id1346862885

### Clover
- **Loves**
  - "Ability to have reports auto emailed to the appropriate people" and "Ease of use for administration and the team" (David H., Restaurants, Feb 2026): https://www.capterra.com/p/226864/Clover/reviews/
- **Hates**
  - The top restaurant UserVoice ideas are about order entry. **Sub Modifiers** has 403 votes and **modifier ordering for item flow** has 92. Others: **multiple non-table sections** for bar tabs and takeout (65), and **delayed kitchen printing** for pre-ordered takeout (63) (vote counts as extracted): https://clover.uservoice.com/forums/963884-restaurant
  - Ideas surfaced in search (paraphrase): a "Repeat"/"+" button to re-fire an item without granting void rights, and showing the current order while adding items on the Flex, because switching screens "interrupts the ordering flow". Same forum.
  - "reporting internally on the machines can be skewed due to different machines being used simultaneously" (Nov 2025): https://www.capterra.com/p/226864/Clover/reviews/

### Lightspeed Restaurant
- **Loves:** easy to learn, and tailors to the restaurant (paraphrase): https://www.merchantmaverick.com/reviews/lightspeed-restaurant-review/
- **Hates:** freezing on the front end and interruptions "particularly during peak times". No offline mode. Fees for using an outside processor (paraphrase, same URL).

### SpotOn
- **Loves:** handles "complex menu modifiers effortlessly" and "Customizable reports deliver powerful insights" (Tadeo C., Sep 2025). Also "24/7 Customer Service" with "fast fixes for most things" (Cindy C., May 2025): https://www.softwareadvice.com/retail/spoton-restaurant-profile/
- **Hates:** "Constant handheld issues caused our staff years of grief during busy times" (Rachel W., Apr 2025). "We were told no contracts…but then we had to get new equipment which meant we had to sign a contract", same reviewer. "Sometimes it's hard to get customer service on the weekend" (Sep 2025). Same URL.

### Revel
- **Loves:** "You can have modifiers for modifiers… their menu system is probably the best" (Matt W., Apr 2025). "Reporting is real time and accurate" (Sarah S., Jun 2023): https://www.capterra.com/p/135040/Revel-iPad-POS/reviews/ . Combo and pizza-building screens (paraphrase): https://fitsmallbusiness.com/best-pizza-pos-systems/
- **Hates:** "Their 'Offline Mode' never worked for us and if we had no internet, that meant we were 100% down" (Matt W., Apr 2025). "Customer service can be disastrous at times, especially if your POS system is down during a rush." "Tons of data. No way to mine it." All from the same Capterra URL. 3-year contract (paraphrase, Fit Small Business).

### TouchBistro
- **Loves:** "Ease of adding chairs to tables, and the simplicity of swiping left to remove items was great" (Mike W., Feb 2026): https://www.softwareadvice.com/retail/touchbistro-profile/reviews/ . Easy table and bill splitting (paraphrase, search summary of Capterra).
- **Hates:** "Offline mode is an absolute joke. You have to turn it on before your connection signal goes out" and "sometimes we were resorting to using paper and manually calculating taxes" (Aidee H., Oct 2025). "there are sporadic glitches where reports don't match between the machine and online" and "Getting help from a person is a nightmare" (Elizabeth K., Jan 2026). All from the same URL.

### Lavu
- **Loves:** "a nested system, which allows for exceptional capabilities to modify even the most complex orders" (Aug 2025): https://www.capterra.com/p/118828/Lavu/reviews
- **Hates:** "Split bills require your staff to have a post-graduate diploma with 10+ years of practice" (Apr 2025). "When it doesn't work, it totally halts service" (Oct 2020). "The printer stops working sometimes so we have to close the app and reopen it again" (Oct 2021). "The total of revenue doesn't matching, has to be manual counted after cashier closing" (Aug 2020). "Can't Add a cc to an existing tab" (Oct 2020). All from the same URL.

### HungerRush (formerly Revention)
- **Loves:** "Robust pizza platform that options such as toast and square lack", plus built-in "Caller ID, online ordering, rewards, and gift card" (Joshua K., pizzeria owner, Sep 2022). "Delivery dispatch setup is very intuitive…shows estimated delivery time" and "24/7 support is great" (Thomas F., Sep 2024): https://capterra.com/p/122189/HungerRush360/reviews/
- **Hates:** "They nickel and dime a bit…charge extra for new features" (Joshua K.). "The reporting can be glitchy sometimes" (Thomas F.). "System likes to crash" (Vicki K., Oct 2020). All from the same URL. "Dated POS system, not the easiest to update and navigate" (Roberto M., owner): https://www.getapp.com/retail-consumer-services-software/a/hungerrush/reviews/ . A holiday crash forced manual phone orders and long holds (paraphrase of a search summary; source review not opened).

### SpeedLine
- **Loves:** Caller ID that skips asking for the number, shows active orders when a customer calls to check on one, and keeps a missed-call list (vendor, paraphrase): https://www.speedlinesolutions.com/delivery . "Dynamic order screens show ingredients and modifiers at a glance": https://fitsmallbusiness.com/best-pizza-pos-systems/ . Capterra 4.7/5 (paraphrase, search summary).
- **Hates:** an outdated UI and a high price (paraphrase, G2 summary via search). "Some updates can only be made by the SpeedLine support team" and "Limited customer support and service hours" (Fit Small Business).

### Slice Register
- **Loves:** "Easy to use with ipad" (Jun 2022): https://capterra.com/p/228745/Slice/reviews/ . Counter, phone and online in one workflow (vendor, paraphrase): https://sliceregister.com/home
- **Hates:** "We need to know choices for crust, sauce, whole pizza toppings then half pizza toppings, in that order" (Nelson D., Jun 2022). "I wish we had more control of the menu and modifiers." "Reporting tools need to be revamped to provide more order detail history." All from the same URL. Only one processor (Adyen) (Fit Small Business).

### PMQ (pizza trade press)
- Operators said the functions they actually use are "customer history and the closing functions at the end of the night." They skip the rest because learning "was taking too much time and they had a business to run" (2003): https://www.pmq.com/the-pmq-p-o-s-report/
- Caller ID plus Last Order Recall is standard in pizza POS (paraphrase, search summary): https://www.pmq.com/cutting-edge-pos-systems-are-working-smarter-and-harder-for-you-and-your-customers/
- A Givex executive says a pizza POS must "handle complex pizza orders, such as easily switching toppings or offering left-side, right-side and double/triple toppings" (vendor voice): https://www.pmq.com/does-your-pos-system-deliver/

---

## 2. Cross-vendor FOH feature map

"Praised" and "Criticized" list only what I found evidence for. A blank cell means no evidence, not that the feature is absent.

| Feature | Praised | Criticized / missing | Notes for us |
|---|---|---|---|
| Order entry speed | SpeedLine ("at a glance"), Lightspeed (easy to learn), TouchBistro (swipe to remove) | Toast slows when busy. Clover: flow interrupted by switching screens; modifier ordering (92 votes). Square: "easier and faster to select" | The single biggest daily-feel factor. Everything else rides on it |
| Pizza builder / half-and-half | HungerRush, Revel, Toast over Square | Square (3 threads, 2022–2026), Slice (order of halves), Toast (H1/H2 workaround) | Must include half pricing rules (highest half, average, per-half) |
| Nested / sub-modifiers | Revel, Lavu, SpotOn | Clover (403 votes, top idea) | Our flat groups cannot express "Extra" under a topping |
| Phone order: caller lookup + history + reorder | HungerRush, SpeedLine, Toast (docs), PMQ | Square (no phone/to-go flow, multi-year request) | We already store phone on every order, so history exists on day one |
| Delivery address on ticket | SpeedLine and HungerRush dispatch | Square (address not on ticket, 2025) | Address, phone and notes must print on every delivery ticket |
| Pay later (cash at pickup) | | Square (2022 request) | Our default today (`payment_status = pending`) |
| One queue for all to-go channels | Slice (unified) | Square (merge request), Clover (non-table sections, 65 votes) | We have the admin inbox, so extend it rather than fork it |
| Open checks / tabs | Lavu (pre-auth tab) | Toast (one bill open at a time), Square (tab management), Lavu (can't add a card to a tab) | Dine-in only; low volume for a pizza counter |
| Hold / fire, scheduled orders | Toast (quote/fire timing, docs) | Square (can't hold), Clover (delayed printing, 63 votes) | Future orders must not hit the make line early |
| Split checks | TouchBistro (easy splitting, paraphrase) | Square (single item, by seat), Lavu ("post-graduate diploma") | Split by item and evenly by N covers most cases |
| Discounts / comps / voids with manager approval | Square (passcode gate, when it works) | Square (gate silently lost; split-item theft), counter request for audit | Audit every void, and never depend on client-side permission state |
| Employee PIN switching | | TouchBistro (clock-in friction), Lavu (locked out) | Fast PIN with no passwords at the counter |
| Cash drawer / shift close | Square (cash tip declaration) | Lavu (revenue mismatch at close), PMQ (closing is a core use) | Without a card integration the drawer is the main thing that has to reconcile |
| Tips | Square (cash tip claim) | Square (tip prompt unreadable, 2019) | Record card tips keyed from the terminal slip |
| Offline mode | Toast (keeps running), TouchBistro/SpotOn (advertised) | Square, Revel, Lightspeed, TouchBistro ("joke"), Lavu, HungerRush crash | See section 3, complaint 2 |
| Receipts / tickets | | Square (delivery info missing), printers dropping (Square, Lavu) | Browser print first |
| Reporting | Toast, Revel, SpotOn, Clover (auto-email) | Reports that don't match (TouchBistro, Lavu, Clover multi-device, Toast deposits). Glitchy (HungerRush). Can't export (Toast). Can't mine (Revel) | One source of truth in Postgres removes the cross-device mismatch class |
| Quote times | Toast (4 strategies, docs), HungerRush (delivery ETA) | | We have static prep minutes, so make the quote live from the KDS queue |
| 86 / out of stock | | Toast (OOS items unrecallable) | We have `isAvailable`, so reorder must handle 86'd items gracefully |
| Support / learnability | HungerRush, SpotOn (24/7) | Nearly every vendor (see section 3) | We are the vendor. Learnability is our support |

---

## 3. Leading complaints, ranked by frequency, with what we build

Count = distinct vendors with at least one cited complaint in section 1, with distinct threads or reviews in parentheses where that is the better signal. Ties are ordered by thread count.

**1. Support is unreachable or unhelpful (9 of 11 vendors: Toast, Square, SpotOn, Revel, TouchBistro, Lavu, HungerRush, SpeedLine, Slice; also PMQ 2003).** Operators want help *during the rush*. Build: we own the software, so the answer is a POS that needs no support call. That means no settings that can silently change behavior, an in-app "what happened" log on each order (who voided what, when), and a visible health strip (DB reachable, KDS connected, last sync). PMQ's finding that operators use only history and closeout argues for a small surface over a deep one.

**2. Outages, crashes and lag during the rush (8: Toast, Square, Lightspeed, SpotOn handhelds, Revel, TouchBistro, Lavu, HungerRush).** Build, without hardware:
- An idempotent order submit. The client generates the order UUID, so a retry after a timeout cannot double-ring a pie. The schema already uses a uuid PK.
- An offline capture queue. If a submit fails, the order is saved in IndexedDB with its UUID. It shows as "NOT SENT" in red, prints a paper ticket through the browser print dialog so the kitchen can start, and replays when the connection returns. *Limit:* a Neon-backed KDS also goes dark when the internet does. Real store-and-forward to the KDS needs a local server, which is out of scope for v1. Say so in the UI rather than claim an offline mode (TouchBistro's "joke" complaint is about exactly that overclaim).
- Performance budgets. Menu and modifiers stay cached client-side. Adding an item never waits on the network. Only "send" does.

**3. Fees, contracts and billing surprises (8: Toast, Square, SpotOn, Revel, HungerRush, Slice, Clover, Lightspeed).** Not a product feature for us. It is the reason to build instead of buy. Build: nothing. Keep the "record external card payment" path vendor-neutral so the processor stays swappable when Stripe lands.

**4. Reports don't match reality (7: Toast deposits/export, Clover multi-device, TouchBistro machine vs online, Lavu close, HungerRush, Revel, Slice).** Build: one ledger in Postgres. Every tender (cash, external card, comp) is a row tied to an order and a shift. Shift close shows expected cash vs counted cash, card total vs the terminal batch total the closer types in, and every void, comp and discount with who approved it. Add CSV export of order lines (answers Toast's pivot-table complaint) and an emailed end-of-day summary (Clover's loved feature).

**5. Pizza building / half-and-half (3 vendors, 5 threads: Square ×3, Slice, Toast; FSB and Givex describe the same gap).** Build: placement (WHOLE / LEFT / RIGHT) as data on each topping selection, never a modifier name. Half-topping pricing is a store setting: half of the whole price, highest-half, or average (the two operators who asked used both of the last two). The builder keeps a fixed entry order: size → crust → sauce → cheese → whole toppings → half toppings. Slice's reviewer asked for exactly that order. The same data drives the KDS's LEFT/RIGHT blocks.

**6. Modifier entry is slow or can't express the menu (3 vendors: Clover 403 + 92 votes, Square, Slice; Lavu and Revel are praised for nesting).** Build: one-screen pizza entry with toppings as a grid. Tap cycles normal → extra → light → none, and long-press picks the half. The running order stays visible beside the builder (Clover Flex request). Add a quantity stepper and a "repeat line" button that doesn't need void rights (Clover "Repeat" idea).

**7. Phone and to-go orders are second-class (2 vendors, 5 threads: Square merge request, pay-at-pickup, address on ticket; Clover non-table sections, delayed printing).** Build: the phone number is the first field. Typing it brings up name, saved addresses, the last 5 orders, and one-tap "Reorder" (Toast and HungerRush loves, PMQ "Last Order Recall"). Reorder re-prices at current prices and flags 86'd items. Delivery tickets always print address, phone and notes. Phone orders land in the same queue as online orders, with a channel badge.

**8. Voids, discounts and permissions leak money (2 vendors, 4 threads: Square permission regression, split-item theft, counter-shop request; Clover repeat-without-void).** Build: server-enforced roles (cashier, manager, owner). Voiding a sent item, comping, discounting above a threshold, opening the drawer with no sale, and refunds all require a manager PIN *at the moment of the action*. Each one writes an audit row with reason, approver and time, and it shows on the shift report. Permissions are checked on the server, so a client update can't drop them.

**9. Split checks are clumsy or missing (3: Square single-item and by-seat, Lavu, Toast one bill).** Build for dine-in: split evenly by N, split by item, and split one item across N checks with cents allocated deterministically. Each split check carries its own tenders.

**10. Hold / fire and future orders (2: Square, Clover 63 votes).** Build: "Fire at" time on any order. It sits in a Scheduled lane and auto-fires to the KDS at `promised time − quote`. A manual Hold button keeps a dine-in course back.

**11. Staff login friction (2: TouchBistro clock-in steps, Lavu lockout).** Build: a 4-digit PIN switches the active employee in under a second. The terminal stays signed in at the device level (the current operator login), and the screen auto-locks back to the PIN pad after N seconds idle or after each sent order.

---

## 4. Pizza counter specifics a generic restaurant POS handles badly

1. **Halves are data, not notes.** Generic systems model a pizza as an item with modifiers. Pizza needs placement per topping and a half-pricing rule. Every Square thread above is this problem.
2. **Phone first, not table first.** Square, Clover and TouchBistro center the floor plan. A pizza counter centers phone number, address and reorder. Dine-in is the minor case.
3. **Delivery is part of the order.** Address, cross-street notes, zone and fee, and the phone number must travel with the ticket to the kitchen and the driver (Square 783334).
4. **Pay later is normal.** Pay at pickup, cash at the door. The order is fired before it is paid, so "unpaid but made" has to be a first-class state with an end-of-night list.
5. **Quote time has to reflect the oven.** Callers ask "how long?" on every call. The quote should come from pies ahead in the KDS queue × bake time, not a fixed 20 minutes (Toast's Kitchen Capacity strategy is the closest analog).
6. **Volume of identical, heavily modified items.** "2 large half pep half mushroom, well done" must be one line with qty 2, entered in about 5 taps.
7. **Specials and combos.** "Large + wings + 2L" deals need bundle pricing. Revel and FSB rate combo builders as a pizza differentiator. *Inference:* defer past v1 unless Mink's runs deals.

---

## 5. Recommended v1 scope, ordered by impact

Each line names what it answers. C# refers to the numbered complaints in section 3, and L to a loved feature.

1. **Fast order entry screen** for walk-in, phone and dine-in, with the menu cached client-side, the order panel always visible, a qty stepper and a repeat line. Answers C2 (lag), C6 (entry speed), L: SpeedLine "at a glance".
2. **Pizza builder with WHOLE/LEFT/RIGHT placement**, a tap-cycle for normal/extra/light/none, fixed entry order, and a configurable half-pricing rule. Shares the model with the KDS. Answers C5, C6. Needs schema: placement and amount on each order-line modifier.
3. **Phone-number-first customer lookup**, with history, saved addresses and one-tap reorder (re-priced, flags 86'd items). Backfill the customers table from existing `orders.customer_phone`. Answers C7, L: Toast/HungerRush/SpeedLine caller history, PMQ "customer history".
4. **Unified to-go queue** that adds POS phone and walk-in orders to the existing admin inbox and KDS feed, with a channel badge (walk-in / phone / online / dine-in). Needs schema: `channel`, and a `dine_in` order type. Answers C7 (Square merge request, Clover sections).
5. **Delivery handling**: address, notes and phone on every delivery ticket; delivery minimum and fee from settings. Answers C7 (Square 783334).
6. **Live quote time** from KDS queue depth × oven minutes, shown to the cashier while on the phone and saved as `promised_at`. Answers L: Toast quote strategies, HungerRush ETA, and the RESEARCH.md "static ETA" gap.
7. **Staff PINs and server-enforced roles**, with auto-lock to the PIN pad. Answers C11, C8.
8. **Manager-approved voids, comps, discounts and no-sale opens**, each with reason and audit row. Answers C8.
9. **Tender recording without hardware**: cash (amount tendered → change due), "card on external terminal" (amount plus tip plus optional last 4), comp, and pay later. Many tenders per order. Answers C4, and keeps C3 processor-neutral for Stripe later.
10. **Shift open/close and drawer count**: starting bank, expected vs counted cash, card total vs the terminal batch the closer enters, cash tip declaration, an unpaid-orders list, and voids/comps by employee. Answers C4, L: Square cash tip declaration, PMQ "closing functions".
11. **Idempotent submit plus offline capture queue plus browser-printed fallback ticket**, with an honest "NOT SENT" state. Answers C2.
12. **Order activity log and health strip** on each order and on screen. Answers C1, C2.
13. **Fire-at / scheduled orders and Hold.** Answers C10.
14. **Open dine-in checks with split** (even, by item, one item across N). Answers C9 and Toast "one bill open at a time". Placed late because dine-in is the minor channel at a pizza counter.
15. **End-of-day email and CSV export of order lines.** Answers C4, L: Clover auto-emailed reports, Toast export complaint.

**Out of v1 on purpose:** combos/deals engine, loyalty, gift cards, driver dispatch maps, true LAN offline with a local server, and card-present payments (Stripe Terminal later). Each is either low-evidence for a single-location shop or blocked on hardware.

**Bottom line.** Across vendors, operators complain most about things a self-built web POS can avoid by design: slow or flaky software in the rush, reports that don't reconcile, and permissions that leak. Pizzerias add three specific gaps: half-and-half as real data, a phone-first flow with history and reorder, and delivery details on the ticket. A v1 built around items 1 to 11 answers the complaints that recur across seven or more vendors (support burden, rush outages, reports), and the pizza gaps that drove operators to HungerRush and SpeedLine.
