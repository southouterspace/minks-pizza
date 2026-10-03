# Kitchen Display System (KDS) Research: What Operators Love and Hate

Research date: 2026-10-03. Scope: Toast, Square, Fresh KDS, Clover, Lightspeed, SpotOn, Revel, Oracle Simphony, QSR Automations ConnectSmart, Lavu, plus pizza-first POS vendors (HungerRush, SpeedLine, Slice Register). Pizzeria feedback is prioritized.

**Method and limits.** Reddit could not be fetched from this environment (`reddit.com` is blocked for the fetch tool) and web search did not surface usable Reddit threads, so this report has **no Reddit evidence**. The PMQ Think Tank forum did not resolve, and the Toast Community pages returned 403, so Toast Community evidence comes from search-result summaries and is marked *(paraphrase)*. Text in quotation marks was pulled from the cited page. Owner.com has no KDS feedback in what I found. G2 and Capterra pages that could not be loaded are not cited for specific claims.

---

## 1. Per-product loves and hates

### Toast KDS
- **Loves**
  - Durable hardware built for heat, grease and steam (paraphrase): https://fitsmallbusiness.com/best-kitchen-display-systems/
  - Color-coded tickets that show dining option (here, takeout, delivery) (paraphrase): https://fitsmallbusiness.com/toast-pos-review/
  - Routing by station, ticket throttling, an expo screen that combines prep stations, an All Day view, and a production item count: https://support.toasttab.com/en/article/KDS-All-Day-1493055871075 , https://doc.toasttab.com/doc/platformguide/adminUsingExpo.html
  - Recall of the last fulfilled ticket, plus "Show Recently Fulfilled" → Unfulfill: https://doc.toasttab.com/doc/platformguide/adminRedisplayingTickets.html
  - Pizzeria owners say Toast handles pizza combos and delivery better than Square (paraphrase): https://fitsmallbusiness.com/best-pizza-pos-systems/
- **Hates**
  - **Half pizzas need menu workarounds.** One pizzeria said "1st half" toppings came out scrambled on the kitchen ticket, in on-screen order instead of the order they were entered. The fix is H1/H2 modifier groups plus a modifier-sorting setting (paraphrase): https://community.toasttab.com/t5/pizzeria/half-pizza/m-p/2936 . Another operator found a "left half" modifier did not clearly tell the kitchen it applied to only that half, so pies were made wrong (paraphrase): https://community.toasttab.com/t5/pizzeria/see-picture-how-to-include-quot-left-side-quot-and-quot-right/td-p/3423
  - **Production item count lags during rushes.** One operator said counts were almost always wrong during busy periods, even after network upgrades, and was close to dropping the feature (paraphrase): https://community.toasttab.com/t5/restaurant-operations/kds-production-item-count-lag/m-p/18240
  - **Offline mode is partial.** Online and off-premise orders are not received during an outage, and a local network outage stops POS→KDS tickets entirely: https://support.toasttab.com/en/article/Using-Toast-in-Offline-Mode , https://doc.toasttab.com/doc/platformguide/platformOfflineKDSDevices.html
  - Text size is tied to the row/column grid and cannot be set on its own: https://support.toasttab.com/en/article/Customize-the-Appearance-of-KDS-Tickets
  - Tickets freeze or disappear if a device switches between Wi-Fi and Ethernet: https://support.toasttab.com/en/article/Why-aren-t-tickets-showing-up-on-my-Kitchen-Display-Screen-KDS
  - Billing surprises, such as being charged for KDS screens sent by mistake (paraphrase, Trustpilot): https://www.trustpilot.com/review/toasttab.com?page=6

### Square KDS
- **Loves**
  - Cheap and easy to start with. An All Day Count was added in 2021 after a chef asked for "a total count of each item across all the active tickets": https://community.squareup.com/t5/Archived-Discussions-Read-Only/KDS-Recommendations-With-A-Total-Item-Count-All-Day-View/m-p/242018
- **Hates**
  - **Missing tickets with no recall.** "Square KDS randomly not displaying tickets from the POS… there appears to be no way to recall that missed ticket." The operator said it happened about "1-3 times per 100 tickets", and the only clue was "the ticket numbering missing one." A second operator: "in the middle of service kds will stop displaying tickets": https://community.squareup.com/t5/Payments-Troubleshooting/Square-KDS-randomly-not-showing-tickets/m-p/319338
  - Completed tickets "jumping back and forth between open and completed", then "5-7 new tickets show up all at once" (Oct 2025): https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Square-KDS-Completed-Tickets-Reappearing/m-p/822187
  - **No native half pizza.** A pizzeria asked for "Half 1"/"Half 2" partial portions (2023), and Square said it was "not a feature our Product Team currently has planned." A 2024 follow-up: "This is a standard pizza shop necessity": https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Pizza-Toppings-partial-portions/m-p/686056 . In 2025 an operator was still adding manual notes to every half order: https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Square-Restaurants-for-Pizza-location/td-p/820140
  - **Tickets can't move from make line to oven.** A pizza shop wanted tickets to leave the make-bench KDS and appear on a second screen once the pie goes in the oven. The answer: "you can't complete an order on one KDS and then have it appear on a second": https://community.squareup.com/t5/Hardware-Setup-Troubleshooting/Can-Square-KDS-Route-Orders-from-Prep-Stations-to-Expo-Stations/td-p/822026
  - No routing by modifier ("route to KDS based on certain modifiers"): https://community.squareup.com/t5/Feature-Requests/KDS-kitchen-routing-for-Modifiers/idc-p/840724 . No modifier counts in All Day, with the answer "just does not exist": https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Quantify-Modifiers-on-KDS/m-p/821769
  - Depends on the cloud, so losing internet loses tickets (paraphrase): https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/ . The iOS app was shut down in January 2026, forcing a move to Android: https://squareup.com/help/us/en/article/7397-square-kds-guide

### Fresh KDS (Fresh Technology)
- **Loves**
  - Inexpensive, wireless, works with Square and Clover. Recent App Store reviews praise fast text support during a lunch rush ("I LOVE my KDS!"): https://apps.apple.com/us/app/fresh-kds-1-kitchen-display/id1399974398
  - Operator "NewYorkPizza": "4 running simultaneously and they all work well": https://community.squareup.com/t5/Archived-Discussions-Read-Only/Anyone-having-trouble-with-FreshKDS/td-p/12928
- **Hates**
  - Reliability. "Great when it works but works 50% of the time" (2023), with orders appearing hours later. Another reviewer reported crashes every 30 minutes after an update: https://apps.apple.com/us/app/fresh-kds-1-kitchen-display/id1399974398
  - An update doubled the price and **removed bold font**, making screens harder to read (2019 review, same URL).
  - Same pizza operator: "unresponsive to nearly all requests". Others reported "dropped tickets often": https://community.squareup.com/t5/Archived-Discussions-Read-Only/Anyone-having-trouble-with-FreshKDS/td-p/12928

### Clover Kitchen Display
- **Loves**
  - One 20-year operator called it "by far the best product i have ever used" (paraphrase of a review summary): https://www.capterra.com/p/226864/Clover/reviews/
- **Hates**
  - Operator wish list on Clover's own forum: "strikethrough a modifier… warn with different colors like yellow and red", "online ordering should be their own separate set of orders numbers", "Need sound notification whenever an order comes in", "Any deletes for printed items should go to the KDS". A reseller adds: "Losing merchants to Toast on this!": https://clover.uservoice.com/forums/963884-restaurant/suggestions/42693188-kitchen-display-screen
  - Lags at high volume. Complex modifiers are a weak spot (paraphrase): https://pos.toasttab.com/blog/clover-pos-reviews (a Toast-authored page, so possibly biased)

### Lightspeed KDS
- **Loves**
  - Real-time updates across devices. Lightspeed's own survey found 56% of staff call last-minute changes the top disruption, and 23% struggle to balance dine-in and delivery: https://www.lightspeedhq.com/news/lightspeed-introduces-the-next-generation-kitchen-display-system/
- **Hates**
  - iOS only, with **no offline mode** (paraphrase): https://www.merchantmaverick.com/reviews/lightspeed-restaurant-review/

### SpotOn KDS
- **Loves**
  - "Interactive and easy to read". Online orders route straight to stations. Offline mode is advertised (paraphrase): https://www.softwareadvice.com/retail/spoton-restaurant-profile/
- **Hates**
  - Glitches. One KDS never worked right despite repeated support calls, with long phone waits (paraphrase), same URL.

### Revel
- **Loves**
  - Highly customizable tickets and alerts, plus split-screen views (paraphrase): https://fitsmallbusiness.com/best-kitchen-display-systems/
- **Hates**
  - 3-year contract and expensive for a small shop (paraphrase), same URL.

### Oracle MICROS Simphony KDS
- **Loves**
  - Deep workflow: production lanes, load balancing, bump bar support (paraphrase): https://www.itechguides.com/best/kitchen-display-system-software/oracle-micros-simphony-kds/
- **Hates**
  - Only makes sense inside the Oracle ecosystem. Sales-quoted pricing. The KDS controller runs on an on-premise service host (same URL).

### QSR Automations ConnectSmart Kitchen
- **Loves**
  - "Rock solid" screens. Lower cook times and less kitchen noise (paraphrase): https://www.softwareadvice.com/retail/connectsmart-profile/
- **Hates**
  - Hard to configure. The CSK Builder tool has "checkboxes everywhere", operators depend on sales engineers, and old versions can't be upgraded (paraphrase), same URL.

### Lavu KDS
- **Hates**
  - "dropping orders, freezing during busy hours, no memory backup". It "randomly crashes and any orders that were up are gone". "no adjustable font size/ticket width size". With large parties nothing tells you to scroll (paraphrase): https://apps.apple.com/us/app/lavu-kds/id437565964

### Pizza-first systems (HungerRush, SpeedLine, Slice Register)
- **HungerRush**
  - **Loves:** handles half-and-half and light toppings, which reviewers say Toast and Square lack. Also "Online ordering tickets print seamlessly in the kitchen": https://capterra.com/p/122189/HungerRush360/reviews/
  - **Hates:** charges extra for features, and small operators wait more than a year for releases (paraphrase), same URL.
- **SpeedLine**
  - **Loves:** "Dynamic order screens show ingredients and modifiers at a glance": https://fitsmallbusiness.com/best-pizza-pos-systems/ . Pizza case study: "Pizza's out the door very, very fast. We are killing delivery times" (Mama Roni's): https://www.speedlinesolutions.com/blog/kitchen-display-systems-increasing-efficiency-in-your-pizza-kitchen
- **Slice Register**
  - **Loves:** easy setup. "sends alerts and has alot of detail."
  - **Hates:** "Lack of integration, menu item printing routing. Issues with modifiers!!" and "glitchy where you are allowed to [write] in special instructions": https://capterra.com/p/228745/Slice/reviews/?page=2

---

## 2. Pizza-specific pain points

| Pain point | What the evidence shows |
|---|---|
| **Half-and-half toppings** | The most-cited pizza gap. Square has no native halves, and its own Champion offers a duplicate "Side A/Side B" workaround. On Toast, topping order gets scrambled and "left half" is unclear without careful modifier nesting. HungerRush is praised for exactly this. (Square 686056 and 820140, Toast 2936 and 3423, HungerRush Capterra) |
| **Modifiers (extra/light/no)** | Clover operators want modifiers struck through and color-flagged. Slice reviewers report "Issues with modifiers!!" Square can't count or route by modifier. Lightspeed's survey ranks last-minute modifications as the top disruption. |
| **Make line → oven → cut/expo routing** | A pizza shop asked Square for a two-stage handoff (make bench, then oven) and was told it can't be done. Toast supports prep → expo but has an open thread on tickets reordering on expo after prep bumps. PMQ operators have historically mirrored one screen at dough/sauce and another facing the oven (paraphrase of a search snippet; the forum itself was unreachable). |
| **Size/crust prominence** | No direct operator quotes found. It follows from the half-topping scramble complaints and SpeedLine's "at a glance" pitch. *Inference.* |
| **Bake-time timing** | Green/yellow/red aging is standard (Pizza Today). SpeedLine highlights delay timers so items are "hot and ready" together. No reviewed KDS offers a timer tied to the oven (conveyor exit or deck bake). *Gap.* |
| **Bump bars, grease, flour** | Pizza stations commonly use bump bars because touch fails with flour, oil and gloves (vendor guidance: https://www.touchbistro.com/blog/what-is-a-bump-bar/). Toast hardware is praised for durability. |
| **Font size** | Fresh removed bold font in an update. Lavu has no adjustable font. Toast ties font size to grid density. |
| **Channel distinction** | Clover operators want online orders on their own number series. Toast's dining-option color coding gets praise. Lightspeed: 23% struggle to balance dine-in and delivery. |
| **Third-party orders** | Slice users complain the platform isn't integrated with their POS. Square and Toast pull DoorDash and Uber Eats into the KDS when configured; misconfigured dining options cause missing tickets. "Tablet hell" statistics (RestauNax) have no stated source, so treat them as weak evidence. |
| **Consolidation ("12 large pepperoni")** | Toast and Square have All Day views, but Toast's count lags in rushes and Square can't count modifiers. For pizza that means toppings and sizes go uncounted. |
| **Recall** | Toast does it well (last ticket plus a recently-fulfilled list). On Square, a missed ticket means "you just don't get to see it," and it can't be re-sent. Lavu loses orders on a crash. |
| **Color timers and audio** | Clover operators ask for sound on new orders and yellow/red warnings. Aging colors are table stakes (Pizza Today). |
| **Offline reliability** | The top trust issue overall. Square loses tickets without internet. Lightspeed has no offline mode. Toast keeps in-store orders only with a local hub and drops online orders. Katalyst: "A printer depends on nothing but power and paper." https://www.katalystos.com/blog/do-you-need-a-kitchen-display-system |
| **Friday rush** | Lavu and Fresh fail "during busy hours". Toast item counts go wrong during rushes. SpeedLine's pitch centers on "Friday nights". |

---

## 3. Feature requirements for a pizzeria KDS

| # | Requirement | Priority | Rationale (evidence) |
|---|---|---|---|
| 1 | Native whole / left / right half topping model, shown as separate labeled blocks (e.g. **WHOLE**, **LEFT ½**, **RIGHT ½**), never relying on modifier order | Must | Square has none. Toast scrambles order. HungerRush wins on this. |
| 2 | Size and crust as the largest text on each item line (e.g. **LG THIN**) | Must | Gap inferred from the half-pizza confusion threads. Fastest read at the make line. |
| 3 | Modifier styling: NO = struck through or red, EXTRA = bold, LIGHT = italic or amber, with special instructions highlighted | Must | Clover strikethrough/color request. Slice "Issues with modifiers!!" Lightspeed 56% statistic. |
| 4 | Make line → oven → cut/expo stage handoff, where bumping moves the ticket to the next screen | Must | Square pizza shop told it's impossible. This is the core pizza workflow. |
| 5 | Local-first operation: tickets keep flowing POS→KDS on the LAN with the internet down, and online orders queue and sync | Must | Square, Lightspeed and Toast online-order gaps. Printer reliability argument. |
| 6 | Guaranteed delivery: sequential ticket numbers with a "missing ticket" alert, and every ticket acknowledged | Must | Square operator only noticed missing tickets from gaps in numbering. |
| 7 | Recall the last bumped ticket in one tap, plus a searchable recently-bumped list | Must | Toast praised. Square and Lavu criticized. |
| 8 | Channel badge and color for dine-in, carryout, delivery, DoorDash, Uber Eats and Slice, with source order IDs | Must | Clover request. Toast color coding praised. |
| 9 | Third-party orders injected directly, with no extra tablets | Must | Slice "not integrated" reviews. Tablet-hell problem. |
| 10 | Color aging timers (green/yellow/red) with thresholds set per station | Must | Pizza Today. Clover request. |
| 11 | Bump bar support and large touch targets that work with floured or gloved hands | Must | Bump bar guidance for pizza stations. |
| 12 | Adjustable font size, set independently of grid density, with bold kept on | Must | Fresh removed bold. Lavu has no font control. Toast ties text to grid. |
| 13 | All Day consolidation by size + crust + topping (e.g. "12× LG PEP"), staying accurate under load | Should | Toast count lag. Square can't count modifiers. |
| 14 | Oven timer: start a countdown when the pie is bumped into the oven (configurable, about 6–8 min for conveyor or deck), then alert the cut station | Should | Gap in every product reviewed. SpeedLine delay timers come closest. |
| 15 | Audio chime on new and modified orders, with a distinct tone for delivery and third-party orders | Should | Clover request for sound. |
| 16 | Live edits and voids flagged on the ticket ("CHANGED", "VOIDED") | Should | Clover "deletes… should go to the KDS". Lightspeed survey. |
| 17 | Routing by item and by modifier (wings, salads and drinks to their own stations) | Should | Square modifier routing request. |
| 18 | Expo screen keeps stable ticket order when prep stations bump | Should | Toast "tickets moving to the front on Expo" thread. |
| 19 | Promised-time and driver-out sorting for delivery tickets | Should | Delivery is the pizza ROI case (Katalyst, SpeedLine). |
| 20 | Visible connection-health banner on every screen | Should | Toast Offline banner. Fresh disconnect complaints. |
| 21 | Scroll or overflow indicator on long tickets (party orders) | Should | Lavu reviewer: no cue to scroll on large tickets (paraphrase). |
| 22 | Ticket-time reporting by station and daypart | Nice | Clover request for "reports when things were fired". Pizza Today staffing data. |
| 23 | High-contrast dark theme readable under glare | Nice | Toast appearance themes. Hardware notes on anti-glare panels. |
| 24 | Throttling or "rush mode" that batches by oven capacity | Nice | Toast throttling praised. |
| 25 | Transparent, flat per-screen pricing | Nice | Toast billing complaint. Fresh price doubling. HungerRush upsells. |

**Bottom line.** Pizzerias put up with generic KDS products but keep fighting four problems: half-pizza display, two-stage make-to-oven flow, tickets dropped when the internet fails, and modifiers that are hard to read. A pizzeria KDS that solves those four and keeps text big and bold would beat Toast and Square for pizza shops on the evidence above.
