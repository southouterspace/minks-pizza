# Promotions & Coupons Research

Research date: 2026-10-03. Scope: feature parity with Toast and other ordering platforms, plus what operators and customers complain about most.

**Source notes**
- Every URL below was fetched or appeared in search results during this research.
- Reddit (r/ToastPOS, r/restaurantowners, r/Dominos, and others) blocked our crawler, so none of its threads are cited. Operator voice comes from the Square Community, Shopify Community, Capterra, and vendor docs instead. Customer voice comes from an aggregate of Domino's app reviews, the Papa John's FAQ, Baymard, and DoorDash/Uber help pages.
- **[inferred]** marks a conclusion we drew ourselves rather than one stated in a source.

---

## 1. Feature matrix

Legend: Y = supported, N = not supported, P = partial or with caveats, ? = not documented in the sources we read.

| Capability | Toast OO (promo codes) | Toast POS | Square (Discounts + Online/Marketing coupons) | Slice | ChowNow | BentoBox | DoorDash (Storefront/Mkt) | Domino's / Papa John's |
|---|---|---|---|---|---|---|---|---|
| % off / $ off | Y | Y | Y | Y (+ free delivery) | Y | Y (item) | Y | Y |
| Max discount cap on % | ? | ? | P (discount setting yes; Online coupons no) | ? | ? | ? | ? | ? |
| Item / category level | Y (item/group/menu) | Y | P (category auto-discounts do **not** apply online) | ? | Y (selected items) | Y (item; 1 item/order default) | Y | Y |
| BOGO / Buy X get Y | Y (via code) | Y | Y (automatic only) | ? | ? | N ("cannot be used for BOGO offers yet") | Y (API types) | Y (combo deals) |
| Combo / bundle price | Y | Y | P | ? | ? | ? | Y (BUY_X_FOR_Y) | Y (core UX) |
| Min spend | Y (min/max check) | Y | P (removed in Marketing migration, then promised back) | Y (advanced) | Y | Y | Y (subtotal, pre-tax/fees) | Y |
| Date window | Y (needs **both** start+end) | Y | Y | Y (expiry) | Y | ? | Y | Y |
| Day/time (happy hour) | Y (discount availability) | Y | Y (schedules; years of complaints before it shipped) | ? | Y | ? | Y | ? |
| Fulfillment-type restriction | ? | n/a | ? | ? | Y | ? | n/a | P (store-level) |
| Auto-apply (no code) | **N online** | Y (BOGO, item-level) | Y (automatic discounts) | Y ("Online Discount") | Y (blank code = auto) | N | Y | Y (deal matching) |
| One use per customer | Y (single-use, by phone) | Y | P (paid Marketing template only) | Y (advanced) | ? | Y (per email) | Y (codes are one-time) | Y ("exceeded max usage") |
| Total redemption cap | ? | ? | Y | ? | ? | Y | ? | ? |
| Unique per-recipient codes | P (create per recipient) | P | Y (Marketing, paid) | N | ? | ? | ? | ? |
| Stacking control | **N online** (no exclusivity) | P ("Allow with other discounts", but "only one promo code") | 1 code/order; bugs let 5 stack | ? | 1 code/order | 1 promo + 1 gift card | 1 code; platform+merchant promos stack | Domino's 1 coupon online; PJ allows multiple of some codes |
| Manager approval / open discount | N online | Y | Y (passcode, variable amount) | n/a | n/a | n/a | n/a | n/a |
| Shown on menu / discoverable | Y ("Display on Menus") | n/a | ? | Y | ? | N (must promote separately) | Y | Y |
| Loyalty reward redeem online | Y (must log in) | Y | Y | ? | ? | ? | ? | Y |
| Reporting | Discounts report; promo-code reporting gap (community thread) | same | Marketing campaign stats | ? | ? | ? | promo spend attribution | ? |
| Case sensitivity | ? | ? | ? | ? | ? | ? | **Case-sensitive** | ? |

Sources:
- Toast: [Set Up a Discount Code for Online Orders](https://support.toasttab.com/en/article/How-to-set-up-a-discount-code-for-online-orders), [Supported Discounts for Online Ordering](https://support.toasttab.com/en/article/Supported-Discounts-for-Online-Ordering), [Get Started With Discounts](https://support.toasttab.com/en/article/Basic-Discount-Configuration), [Troubleshoot Discount Availability](https://support.toasttab.com/en/article/Troubleshoot-Discount-Availability), [Promo code platform doc](https://doc.toasttab.com/doc/platformguide/adminDiscountPromoCodes.html), [Single-Use Promotion Codes](https://support.toasttab.com/en/article/Using-Single-Use-Promotion-Codes), [Toast Marketing FAQ](https://support.toasttab.com/en/article/Toast-Marketing-FAQ), [Toast Local promotions](https://support.toasttab.com/en/article/Do-Promotions-Work-on-Toast-TakeOut), [Discount reporting](https://support.toasttab.com/en/article/Reporting-for-Discounts-Promo-Codes)
- Square: [Create and edit discounts](https://squareup.com/help/us/en/article/6606-happy-hour-and-discounts-with-square-for-restaurants), [vanity coupons](https://squareup.com/help/ca/en/article/6880-create-a-coupon-in-square-online-store)
- Slice: [Owner's App: Manage](https://slice.com/knowledge-hub/owners-app-manage/)
- ChowNow: [Set up a promotion](https://get.chownow.com/restaurant-support/set-up-marketing-promotional-code/)
- BentoBox: [Item Level Promo Codes FAQ](https://help.getbento.com/en/articles/408065)
- DoorDash: [Promo/Discount FAQ](https://help.doordash.com/en-us/business/article/issue-applying-promo), [Promotion Management API](https://developer.doordash.com/en-US/docs/marketplace/retail/promotion_management/overview/)
- Papa John's: [Promotions FAQ](https://www.papajohns.com/customer-service/frequently-asked-promotion-questions.html)
- Owner.com: no public docs found. A review ([savorinsider](https://www.savorinsider.com/p/owner-com-basics-is-this-the-all-in-one-tool-your-restaurant-needs)) mentions email/SMS campaigns with BOGO-style promos and loyalty.
- Olo: no public promo docs found.

**Takeaways on parity**
- In Toast Online Ordering, every online discount needs a promo code. "No auto-apply or open discounts."
- Toast online also has no discount exclusivity: it "cannot restrict discounts from stacking."
- Square is the most flexible: automatic rules, schedules, customer groups, and a max-value cap. Its weak points are the online coupon product and features locked behind paid tiers.

---

## 2. Top operator complaints (ranked by how often and how strongly they come up)

1. **Can't limit a code to one use per customer, or the limit is easy to dodge.**
   - Square seller: "I can't limit the coupon use per customer. Customers can use the coupon over and over." ([Square Community](https://community.squareup.com/t5/Product-Updates/Important-changes-to-your-coupons-on-Square-Online/bc-p/708921#M1339))
   - Square moderator in 2020: "we don't have a way of restricting a coupon to one person per use". The feature shipped about 9 months later ([thread](https://community.squareup.com/t5/Payments-Troubleshooting/Can-we-make-a-one-per-customer-coupon-code/m-p/283823)).
   - Toast says a shared campaign code "is multi-use, so there is no way to prevent a guest from redeeming that shared code more than once" ([Toast Marketing FAQ](https://support.toasttab.com/en/article/Toast-Marketing-FAQ)).
   - Shopify merchants report customers getting around per-customer limits with extra email addresses ([Shopify Community](https://community.shopify.com/t/discount-code-same-customer-multiple-email-addresses/90006/12)).
2. **Codes stack when they shouldn't, or don't stack when they should.**
   - Square seller: "TWO customers TODAY that were able to combine FIVE coupons on ONE order". One order dropped from $300+ to $116.
   - In the same thread, a 15% coupon stacked with sale prices online. The seller noted the POS "will automatically choose the better of the two discounts" ([Square thread](https://community.squareup.com/t5/Archived-Discussions-Read-Only/Multiple-Coupons-How-do-I-limit-the-number-of-coupons-applied/m-p/174842)).
   - Toast online can't restrict stacking at all ([Toast](https://support.toasttab.com/en/article/Supported-Discounts-for-Online-Ordering)).
3. **Minimum spend missing or removed.**
   - Square seller: "I can't set a minimum spend to a coupon so that if I issue a $10 coupon, they can buy lower value items."
   - Another seller: "hundreds of pre-printed flyers … will now be obsolete" ([Square thread](https://community.squareup.com/t5/Customer-Engagement/COUPON-CHANGES-MISSING-quot-ORDERS-OVER-CERTAIN-AMOUNT-quot/m-p/748163/highlight/true)).
4. **No cap on % discounts.** "Square Online doesn't allow us to say that a 10% coupon has a limit of $10 per order" ([Square thread](https://community.squareup.com/t5/Online-Store/In-Square-Online-is-there-an-option-to-limit-a-coupon-to-a/td-p/677112)).
5. **Discount types missing online that the POS supports.**
   - Toast online has no auto-apply, open, or manager-level discounts ([Toast](https://support.toasttab.com/en/article/Troubleshoot-Discount-Availability)).
   - Square category-based automatic discounts "cannot apply to websites or online ordering profiles" ([Square](https://squareup.com/help/us/en/article/6606-happy-hour-and-discounts-with-square-for-restaurants)).
   - BentoBox has no BOGO, and item codes are limited to one item per order ([BentoBox](https://help.getbento.com/en/articles/408065)).
   - A Capterra summary of Toast reviews mentions being unable to discount specific items online, seen in search results only ([Capterra](https://www.capterra.com/p/136301/Toast-POS/reviews/)).
   - Toast COO review: "We wish we had more options when it comes to promo codes and marketing" (same page, fetched).
6. **No scheduled happy-hour windows.**
   - Square sellers spent years asking for this: "every other POS offers it", and "rely on bartenders to remember what time it is" ([Square thread](https://community.squareup.com/t5/Archived-Discussions-Read-Only/Is-there-a-way-to-set-up-automatic-discounts-such-as-for-happy/m-p/82765)).
   - Toast supports scheduled windows, but a promo code needs both a start and an end date before its eligibility window applies ([Toast](https://support.toasttab.com/en/article/How-to-set-up-a-discount-code-for-online-orders)).
7. **Codes leak to coupon sites.**
   - Honey and RetailMeNot scrape codes. "Almost all brands running a referral or affiliate program with discount codes will see a leak" ([Social Snowball](https://www.socialsnowball.io/post/how-to-stop-leaked-discount-codes-and-promo-codes)). See also [Modern Retail](https://www.modernretail.co/marketing/dtc-briefing-how-promo-code-leaks-are-impacting-profit-margins/).
   - Our own searches for ChowNow, Olo, Toast, and Slice codes turned up dozens of aggregator pages (simplycodes, couponfollow, and similar). Any public code should be treated as public.
8. **Promo ROI is hard to measure.**
   - A Toast Community thread is titled "Add Promo Codes to the Discounts report". The fetch returned 403, so we only saw the search snippet. The snippet said promo codes don't show up in reporting unless they are set up a certain way ([thread](https://community.toasttab.com/t5/restaurant-operations/add-promo-codes-to-the-discounts-report/m-p/7951)).
   - Toast points marketers to the "sales discount summary report" to see how a code performed ([FAQ](https://support.toasttab.com/en/article/Toast-Marketing-FAQ)).
9. **Forced migrations and paywalled basics.** Square's move of coupons into Marketing deactivated existing coupons, banned dashes in codes, and put per-customer limits behind a paid template ([Square](https://community.squareup.com/t5/Product-Updates/Important-changes-to-your-coupons-on-Square-Online/bc-p/708921#M1339)).
10. **Cancelled or refunded orders still burn the use.**
    - Shopify marks a code as used even after the order is cancelled, with "no native feature" to release it ([Shopify Community](https://community.shopify.com/t/customer-cannot-reapply-same-discount-code-after-first-order-cancellation/52252), [refund thread](https://community.shopify.com/t/applied-discount-code-availability-after-refund/235511)).
    - Toast Local rewards "cannot be refunded" once redeemed ([Toast](https://support.toasttab.com/en/article/Do-Promotions-Work-on-Toast-TakeOut)).
11. **POS promos and online promos drift apart.**
    - Toast promos don't apply to DoorDash or Uber Eats integration orders ([Toast](https://support.toasttab.com/en/article/Troubleshoot-Discount-Availability)).
    - Domino's deals are app-only, and customers who phoned in "lost both the discount and loyalty points" ([unstar](https://unstar.app/blog/dominos-app-deals-not-working-technical-error-2026)).

---

## 3. Top customer complaints (ranked)

1. **The deal won't apply, or the error is vague.**
   - Of 462 recent negative Domino's app reviews, 31.8% are about deals, coupons, or rewards.
   - Customers see errors like "One or more resources not found" and "your deals are still baking". One wrote: "50% of the time you try to apply a deal, you get a 'resources missing' error" ([unstar](https://unstar.app/blog/dominos-app-deals-not-working-technical-error-2026)).
   - Baymard found that vague, generic errors left users unable to recover, so they abandoned checkout ([Baymard](https://baymard.com/research-articles/adaptive-validation-error-messages)).
   - Toast's own troubleshooting doc lists only an "invalid" rejection and a grayed-out Apply button, with no reason given to the guest ([Toast](https://support.toasttab.com/en/article/Troubleshoot-Discount-Availability)).
2. **The price changes between the deal page and checkout.** "Same deal price shown at every step until checkout, but then price increases" (6.3% of the reviews, [unstar](https://unstar.app/blog/dominos-app-deals-not-working-technical-error-2026)).
3. **Codes expire, or deals expire while the app is broken.**
   - Domino's reviewers describe "Three coupons visibly counting down while redemption path errors" ([unstar](https://unstar.app/blog/dominos-app-deals-not-working-technical-error-2026)).
   - A Papa John's customer was given an apology free-pizza code that was already expired (search snippet from [gethuman](https://gethuman.com/arc/Papa-John-s/55a471c4fffc8a205ce9c807/1)).
4. **A code works in one place but not another (store-level participation).** Papa John's codes are "switched on and off at the store level". Some codes must be entered before choosing items, and some customers couldn't find the code field in the app (search summary of [Papa John's FAQ](https://www.papajohns.com/contact-us/frequently-asked-online-ordering-questions.html)).
5. **Can't combine offers online that the store would combine by phone.** Domino's accepts one coupon online but several by phone ([Slickdeals](https://slickdeals.net/f/16975834-domino-s-pizza-medium-2-topping-pizza-free-w-7-99-qualifying-order-valid-for-delivery-or-carryout), search snippet).
6. **The coupon field sends people hunting for codes.** "5-10% of customers … leave the checkout to search for a discount code" (search summary of Baymard research). Baymard recommends keeping the field collapsed and auto-applying eligible promos ([Baymard](https://baymard.com/blog/checkout-usability-apply-buttons)).
7. **No visible confirmation of what was discounted.** Baymard: "some form of visual highlighting when such a code is applied and changes the price" ([Baymard](https://baymard.com/blog/checkout-usability-apply-buttons)).
8. **Forgot to apply the code, and the store can't fix it after the order.**
   - Uber Eats: codes "cannot be applied if you forgot". A Quora user cancelled within a minute because the code didn't apply and was still charged ([Uber help](https://help.uber.com/h/5a505561-1164-4d5c-a0e8-75ed1ad47c72), [Quora](https://www.quora.com/Uber-eats-stole-my-money-and-wouldnt-refund-it-I-had-a-promo-code-that-wouldnt-apply-so-with-in-one-minute-I-cancelled-my-order-They-still-charged-me-for-the-food-How-is-this-even-legal)).
9. **Case and format errors.** DoorDash: "Promo codes are case sensitive" ([DoorDash](https://help.doordash.com/en-us/business/article/issue-applying-promo)). **[inferred]** Case-sensitive matching fails customers who type codes from flyers on a phone keyboard that auto-capitalizes.
10. **Unclear what the minimum counts toward.** DoorDash had to spell out that the minimum is the "subtotal (before tax and service fees)" ([DoorDash](https://help.doordash.com/en-us/business/article/issue-applying-promo)).
11. **Code lost after editing the cart.** No direct quote found. **[inferred]** from the Domino's apply/remove error reports and Papa John's "enter promo before choosing pizzas" guidance.

---

## 4. Design requirements (Complaint → What we do)

| # | Complaint | What we do |
|---|---|---|
| R1 | One-per-customer impossible or easy to dodge | Per-code `limitPerCustomer`, enforced against a normalized identity: verified phone (E.164), lowercased email with Gmail dots and +tags stripped, and payment fingerprint when available. "First order only" checks order history on any of those keys. **[inferred]** design. |
| R2 | Shared codes leak to Honey/RetailMeNot | Support (a) unique single-use code batches per recipient (Toast single-use, Square Marketing), (b) codeless offers delivered via a signed link or account, (c) a total-redemption cap and a per-day velocity alert, (d) a one-click "kill code" switch. |
| R3 | Unwanted stacking (5 coupons on one order) | One rule engine for both POS and web. Default: at most one *code* per order, plus a per-promo `stackable` flag and an `exclusive` flag. Without an explicit stack, pick the single best discount, the way Square's POS does ("choose the better of the two"). Enforce server-side at order placement, never only in the UI. |
| R4 | No min spend / no % cap | `minSubtotal` measured on the pre-tax, pre-fee, pre-tip item subtotal, stated in the UI the way DoorDash does. `maxDiscount` cap on percentage promos. |
| R5 | Discount types missing online (BOGO, item, combo, auto-apply) | Online parity from day one for % off, $ off, fixed price, BOGO / Buy X Get Y (at $ or % off, cheapest-item rule), combo/bundle price, free delivery, and free item with min spend. Scope each to the check, an item, a category, a size, or a modifier set. Auto-apply and code-required are both first-class. |
| R6 | Can't schedule happy hour | Day-of-week and time-of-day windows in the store timezone, plus optional start/end dates (either one alone works, unlike Toast). Fulfillment filter (pickup/delivery). Validate against the order's *scheduled* time, not the click time. |
| R7 | Vague "invalid code" | Typed rejection reasons, each shown with a specific message: `NOT_FOUND`, `EXPIRED(date)`, `NOT_STARTED(date)`, `OUTSIDE_HOURS(window)`, `MIN_NOT_MET(amount_short)`, `NO_ELIGIBLE_ITEMS(list)`, `ALREADY_USED`, `FULFILLMENT_MISMATCH`, `NOT_COMBINABLE(with X)`, `LIMIT_REACHED`. Each message tells the customer what would make it work, e.g. "Add $4.20 more to use PIZZA10". |
| R8 | Case and format errors | Normalize on entry and on save: trim, uppercase, strip spaces and dashes for matching. Keep the display form, and allow dashes (Square banned them). |
| R9 | Code lost after cart edits / price changes at checkout | Keep the applied promo on the cart, not in UI state. Re-evaluate on every cart change. When an edit makes the promo ineligible, keep the code attached as "pending" and explain why, so it reattaches when the cart qualifies again. The checkout total must equal the cart total. |
| R10 | Hunting for codes, auto deals invisible | Collapse the code field behind "Have a promo code?" (Baymard). Show each applied promo as its own labeled line with the savings. Run a best-deal finder that evaluates all eligible auto-apply promos and stored rewards and applies the best legal combination. Show progress nudges ("$3 away from a free garlic knot"). |
| R11 | Before/after-tax confusion | Merchant-funded promos lower the taxable base: tax is computed after the discount (store coupon rule, [TaxJar](https://www.taxjar.com/blog/calculations/2021-12-sales-tax-discounts-coupons-promotions)). Per promo, set whether it applies to the delivery fee (only free-delivery promos do). Never discount tips. Allocate the discount pro-rata across lines for tax and refunds. |
| R12 | Cancel/refund burns the use | Track redemptions as a ledger: `reserved` at checkout, `consumed` when the order is accepted, `released` on cancel or full refund. On partial refund, recompute the discount allocation. Release expired reservations with a TTL. **[inferred]**, based on Shopify's gap. |
| R13 | Expiring codes confusion | Show expiry on the promo chip and in emails. Optional grace period, and an operator "extend for this customer" action. Log failed redemption attempts so support can honor them (gap noted in the Domino's reviews). |
| R14 | No ROI reporting | Per-promo report: redemptions, unique customers, new vs returning, gross sales, discount cost, average order value against non-promo orders, and top leaking sources (velocity, unknown customers). Exportable as CSV. |
| R15 | POS vs online drift | One promo catalog serving both channels, with per-channel toggles. The same evaluator runs at the counter and on the web. |
| R16 | Forgot to apply | Staff action: "Apply promo retroactively" refunds the difference and records a redemption against the original order, available within N hours. |
| R17 | Operator safety | Preview mode ("simulate this cart"), an audit log of promo edits, and edits that don't change terms for orders already placed. Changes are versioned. |
