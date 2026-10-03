# Delivery Platform Integrations: Marketplace Ingestion and Delivery-as-a-Service

Research date: 2026-10-03. Scope: DoorDash (Marketplace and Drive), Uber Eats (Marketplace and Direct), Grubhub (owned by Wonder), and aggregator middleware (Deliverect, Otter, Chowly, ItsaCheckmate, Cuboh, Olo Rails, KitchenHub). The target is one independent pizzeria running a Next.js + Postgres app that feeds a kitchen display.

**Method and limits.** I used official developer docs first. Two official SDKs gave exact field names where the doc pages render with JavaScript: `@doordash/sdk` 0.6.13 on npm (last published 2024-10-07, OpenAPI-generated) and `github.com/uber/uber-direct-sdk` (last commit 2024-10-24, OpenAPI-generated). These SDKs are older than the docs, so treat them as strong but possibly stale. Deliverect publishes Markdown copies of its docs (`developers.deliverect.com/llms.txt`), which I read directly. The Uber Direct API reference pages (`/docs/deliveries/api-reference/daas` and the cancel page) render only navigation to the fetch tool. The Grubhub developer portal (`developer.grubhub.com`) shows only "loading", and `grubhub-developers.zendesk.com` returned 403. Restaurant Business Online returned 403. Facts from search-result summaries are marked *(paraphrase)*. Text in quotation marks was pulled from the cited page. The fetch tool summarizes pages with a small model. In one case it returned a wrong DoorDash Drive status list, which I caught against the official status page and SDK. Verify every field against the live reference before you ship.

---

## Part A. Marketplace ingestion (orders placed ON DoorDash, Uber Eats, Grubhub)

### A1. DoorDash Marketplace API (POS integration)

**Access.** Partner only. "Marketplace APIs are not yet generally available. Prospective partners can apply for API access directly through the DoorDash Developer Portal": https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/ . Self-Serve Integration Onboarding (SSIO) is for POS providers, defined as partners that "integrate with DoorDash by sending a menu from their environment and receiving orders from DoorDash, sent directly to the in-store POS". You must build Menu Pull and pass SSIO certification: https://developer.doordash.com/en-US/docs/marketplace/overview/onboarding/ssio/ . A single restaurant with a custom POS is not the intended audience.

**Auth (outbound calls).** Same JWT as Drive: HS256, DoorDash version v1, `aud` "doordash", `iss` developer ID, `kid` key ID, `exp` at most 1800 s after `iat`: https://developer.doordash.com/en-US/docs/marketplace/how_to/JWTs/ . Base URL `https://openapi.doordash.com/marketplace`: https://developer.doordash.com/en-US/api/marketplace/

**Auth (inbound webhooks).** The order webhook "contains the same authentication header" as the menu status webhook. DoorDash staff configure the endpoint by hand: https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/ . The portal supports Basic Auth (you supply the `Authorization` header contents) or OAuth (client ID, secret, token URL, optional scope) *(paraphrase of search summary)*: https://developer.doordash.com/en-US/docs/marketplace/how_to/create_webhook_subscription/ . No payload signature is documented.

**New order webhook.** Envelope: `{ "event": { "type": "OrderCreate", "status": "NEW" }, "order": <Order> }`. Key order fields (source: https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/ ):
- `id`: DoorDash order ID, used to confirm.
- `merchant_supplied_id`: your internal order ID.
- `consumer.id` (64-bit integer).
- `fulfillment_type`: Dasher delivery, merchant delivery, or customer pickup. The exact enum strings were not shown.
- `experience`: DoorDash, Caviar or Storefront.
- `estimated_pickup_time`: "estimated time that the Dasher will arrive at the store".
- `delivery_short_code`.
- `items` with nested `options`, and item-level `special_instructions`.
- `subtotal`, `tax`, `merchant_tip_amount`, `tax_amount_remitted_by_doordash`, `is_tax_remitted_by_doordash`.

**Confirm or reject.** `PATCH https://openapi.doordash.com/marketplace/api/v1/orders/{id}`. The API reference shows the method as PATCH: https://developer.doordash.com/en-US/api/marketplace/ . Body:
- `merchant_supplied_id` (required).
- `order_status`: `"success"` or `"fail"` (required).
- `failure_reason`: string, omit on success.
- `prep_time`: UTC datetime, only for merchant-calculated prep times.
- `pickup_instructions`: up to 128 characters.
- `errors[]`: objects with `code`, `merchant_supplied_id`, `message`.

Error codes include `INVALID_ORDER`, `ITEM_OUT_OF_STOCK`, `STORE_HOURS_ISSUE`, `INTERNAL_ERROR`, `CONNECTIVITY_ISSUE`, `TIME_OUT`, `STORE_CLOSED`, `POS_OFFLINE`, `CAPACITY_THROTTLING`, `STALE_PICKUP_TIME`, `ORDER_ONLINE_DISABLED`: https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/

**Deadline.** You can confirm synchronously (return 200 to the webhook, non-2xx means fail). DoorDash wants async if responses regularly exceed about 20 s. For async, return 202 and call the confirm endpoint later. "If you do not confirm the order in 3-8 minutes, DoorDash will treat the order as a failure due to an order confirmation timeout": same URL.

**Other order calls** (https://developer.doordash.com/en-US/api/marketplace/ ):
- `PATCH /api/v1/orders/{id}/cancellation` with `cancel_reason` of `ITEM_OUT_OF_STOCK`, `STORE_CLOSED`, `KITCHEN_BUSY` or `OTHER`.
- `PATCH /api/v1/orders/{id}/adjustment` for item adjustments.
- `PATCH /api/v1/orders/{id}/events/{event_type}`, for example `order_ready_for_pickup`.

**Menu push.** `POST /api/v1/menus` to create and `PATCH /api/v1/menus/{id}` to update. Body: `{ "store": { "merchant_supplied_id", "provider_type" }, "menus": [ { "reference", "open_hours", "special_hours", "menu": { "name", "subtitle", "merchant_supplied_id", "active", "categories" } } ] }`. Prices are in cents. Processing is async, and DoorDash POSTs a result webhook carrying the same `reference`: https://developer.doordash.com/en-US/docs/marketplace/how_to/menu_integration/

**Store availability.** `PUT /api/v1/stores/{merchant_supplied_id}/status` with `is_active`, `reason` (required), `notes` (required), and optional `end_time`, `duration_in_hours`, `duration_in_secs`. Reasons: `out_of_business`, `delete_store`, `payment_issue`, `operational_issues`, `store_self_disabled_in_their_POS_portal`, `store_pos_connectivity_issues`. With no end date, a deactivation lasts two weeks: https://developer.doordash.com/en-US/docs/marketplace/how_to/store_and_item_status/ . Item 86ing is `PUT /api/v1/stores/{merchant_supplied_id}/items/status` and `/item_options/status`: https://developer.doordash.com/en-US/api/marketplace/

**Dasher status webhook.** Values: `dasher_confirmed`, `arriving_at_store`, `arrived_at_store`, `dasher_out_for_delivery`, `dropoff`. Fields include `dasher_status`, `external_order_id`, `client_order_id`, `created_at`, `location_id`, `phone_number` (masked), plus Dasher name and vehicle. You subscribe through your Technical Account Manager, and limited-access partners need approval: https://developer.doordash.com/en-US/docs/marketplace/how_to/dasher_status_webhooks/ . Auto Order Release (AOR) can hold an order until a Dasher is near, then send a release event: https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/

### A2. Uber Eats Marketplace APIs (Order, Menu, Store)

**Access.** "Access to These APIs May Require Written Approval From Uber." You request access through the Integration Support Form: https://developer.uber.com/docs/eats/introduction . Production scopes need your app to be "approved and whitelisted by the Uber Eats team": https://developer.uber.com/docs/eats/guides/authentication

**Auth.** OAuth 2.0 at `https://auth.uber.com/oauth/v2/token`. Tokens last 30 days (2,592,000 s). Client-credentials requests are limited to 100 per hour, so cache the token. Scopes: https://developer.uber.com/docs/eats/guides/authentication
- `client_credentials`: `eats.store` (store and menu), `eats.store.status.write` (availability), `eats.order` (accept, deny, cancel, read v1 orders), `eats.store.orders.read` (read v2 orders), `eats.report`.
- `authorization_code`: `eats.pos_provisioning` (link a merchant's store to your app).

**Webhook signature.** Header `X-Uber-Signature`. Value: "a lowercased hexadecimal HMAC signature of the webhook HTTP request body, using the client secret as a key and SHA256 as the hash function". Respond `200` with an empty body. Uber retries on 500, 502, 503, 504 or network errors at 10 s, 30 s, 60 s, 120 s, up to 7 attempts: https://developer.uber.com/docs/eats/guides/webhooks

**Event types** (same URL): `orders.notification`, `orders.cancel`, `orders.release`, `orders.failure` and `orders.scheduled.notification` (v1.0.0 only), `store.provisioned`, `store.deprovisioned`, `order.fulfillment_issues.resolved`, `store.status.changed`. Added on 2026-07-02: `orders.customer_order_edit`: https://developer.uber.com/docs/eats/api-change-log

**Thin event, then GET.** Yes. The notification carries only IDs: https://developer.uber.com/docs/eats/references/api/webhooks.orders-notification
```json
{
  "event_type": "orders.notification",
  "event_id": "c4d2261e-...",
  "event_time": 1427343990,
  "meta": { "resource_id": "<order_id>", "status": "pos", "user_id": "<store_id>" },
  "resource_href": "https://api.uber.com/v2/eats/order/<order_id>"
}
```
Deduplicate on `event_id`. Fetch the order from `resource_href`, which is GET `/v2/eats/order/{order_id}`. The order body includes cart items with `cart_item_id`, special instructions, eater details, `estimated_ready_for_pickup_at`, and a fulfillment `type` such as `DELIVERY_BY_UBER` *(paraphrase of search summary)*: https://developer.uber.com/docs/eats/guides/order-integration . I could not load the full order schema.

**Accept and deny.** Deadline: accept or deny within 11.5 minutes after acknowledging the webhook: https://developer.uber.com/docs/eats/guides/webhooks
- Accept: `POST https://api.uber.com/v1/eats/orders/{order_id}/accept_pos_order`, scope `eats.order`. Body: `reason` (string), optional `pickup_time` (Unix timestamp), `external_reference_id`, `fields_relayed`, `order_pickup_instructions` *(paraphrase of search summary)*: https://developer.uber.com/docs/eats/references/api/v1/post-eats-order-orderid-acceptposorder
- Deny: `POST https://api.uber.com/v1/eats/orders/{order_id}/deny_pos_order`, returns `204`. Body: `{ "reason": { "explanation", "code", "out_of_stock_items"?, "invalid_items"? } }`. Codes: `STORE_CLOSED`, `POS_NOT_READY`, `POS_OFFLINE`, `ITEM_AVAILABILITY`, `MISSING_ITEM`, `MISSING_INFO`, `PRICING`, `CAPACITY`, `ADDRESS`, `SPECIAL_INSTRUCTIONS`, `OTHER`: https://developer.uber.com/docs/eats/references/api/v1/post-eats-order-orderid-denyposorder
- Cancel: `POST /eats/orders/{order_id}/cancel`, with an optional `cancellation_reason` object since the 2025-08-21 fix: https://developer.uber.com/docs/eats/guides/order-integration , https://developer.uber.com/docs/eats/api-change-log

**Menu.** `PUT /eats/stores/{store_id}/menus` with scope `eats.store`. "A call to this endpoint overwrites any existing menus." The payload is built from `menus`, `categories`, `items`, `modifier_groups`, `display_options` and `service_availability`, with prices in cents: https://developer.uber.com/docs/eats/guides/menu-integration

**Store pause.** `POST https://api.uber.com/v1/eats/store/{store_id}/status`, scope `eats.store.status.write`. Body: `status` (`ONLINE` or `PAUSED`), `paused_until` (ISO 8601), `reason`. Returns `204`: https://developer.uber.com/docs/eats/references/api/v1/post-eats-stores-storeid-status

### A3. Grubhub (owned by Wonder)

Wonder completed its $650M purchase of Grubhub from Just Eat Takeaway *(paraphrase)*: https://www.nrn.com/mergers-acquisitions/wonder-finalizes-acquisition-of-grubhub-for-650-million , https://newsroom.justeattakeaway.com/en-WW/245724-just-eat-takeaway-com-completes-sale-of-grubhub/

Grubhub's merchant page says "Our Grubhub APIs let your development team build Grubhub directly into your restaurant's technology". The path it describes, though, is to "Fill out the form... If we support your POS or middleware solution, we'll work with your provider". Listed partners include Toast, Square, Clover, Olo, Chowly, Deliverect, Cuboh, Otter and KitchenHub: https://get.grubhub.com/products/tech-integrations/

The developer portal documents Marketplace, Partner Integration, Onboarding and Reporting APIs. Access comes through partner onboarding and a pilot, not a self-serve key *(paraphrase)*. Requests use HMAC signing, and webhooks use Basic or a webhook auth scheme *(paraphrase)*: https://developer.grubhub.com/docs/6jV3D6ozbHGczQiB3nRT3v/authentication , https://developer.grubhub.com/docs/5U8mJcEeVfyXajsaVEmUYT/ghconnect-available-webhooks-and-authentication . The portal did not render, so I could not confirm field names. **Verdict: partner-only in practice.**

### A4. Aggregator middleware

The question is whether a custom POS can plug into one vendor and receive orders from all marketplaces. Some vendors work in the opposite direction, which matters.

**Deliverect: yes. Best documented. Partner certification required.**
- Access: apply as an integration partner, then build in staging. "You won't get production access until our certification process is complete." Certification averages two calls: https://developers.deliverect.com/docs/become-an-integration-partner.md
- Auth: OAuth 2.0 client credentials. Token at `/oauth/token` on `https://api.staging.deliverect.com/`, sent as a Bearer token. Cache it until `expires_at`. POS scope: `genericPOS`: https://developers.deliverect.com/reference/access-token.md
- Webhook signature: header `x-server-authorization-hmac-sha256`, a hex HMAC-SHA256 of the raw body. Before certification the secret is the `channelLink` (or `locationId`). After certification you generate a production secret: https://developers.deliverect.com/reference/hmac-authentication.md
- Flow: Deliverect calls your register URL. You reply with `ordersWebhookURL` and `syncProductsURL`. Deliverect POSTs orders to you. You POST `/orderStatus/{orderId}` with 20, 70 and 90. Cancellations arrive as new order posts and you answer with 110: https://developers.deliverect.com/page/pos-diagram-restaurant.md
- Order fields: `_id`, `channelOrderId`, `channelOrderDisplayId`, `channelLink`, `location`, `channel`, `orderType`, `status`, `pickupTime`, `estimatedPickupTime`, `deliveryTime`, `deliveryIsAsap`, `customer.{name,phoneNumber,email,note}`, `deliveryAddress`, `courier`, `note`, `items[].{plu,name,price,quantity,remark,subItems}`, `payment.amount`, `taxTotal`, `tip`, `driverTip`, `discountTotal`, `decimalDigits`, `testOrder`. Integer amounts are scaled by `decimalDigits`: https://developers.deliverect.com/page/glossary-pos-orders.md
- `orderType`: 1 pickup, 2 delivery, 3 eat in, 4 curbside. A cancel request is a new order with `"status": 100` and the original `_id`: https://developers.deliverect.com/v1.1-restaurants/reference/pos_ordercancel.md , https://developers.deliverect.com/page/glossary-pos-orders.md
- POS statuses: 10 New, 20 Accepted, 40 Printed, 50 Preparing, 60 Prepared, 70 Pickup Ready, 90 Finalized, 95 Auto_Finalized, 110 Canceled, 120 Failed: https://developers.deliverect.com/page/order-status.md
- Also offers snooze by PLU, busy mode and holiday hours: https://developers.deliverect.com/v1.1-restaurants/llms.txt
- Price ballpark: about $119/month for 0 to 350 orders, plus setup and transaction fees *(paraphrase, third-party)*: https://zay-os.com/how-much-does-deliverect-cost

**Otter: yes. Public docs. Certification required.**
- POS scenario: "Your POS receives orders from Otter and is the source of truth for menus." Events: `orders.new_order` and `orders.order_status_update`. Store a dedup key first. You certify with your Otter representative: https://connect.tryotter.com/docs/scenarios-pos/
- Webhook signature: header `X-HMAC-SHA256`, a **base64** HMAC-SHA256 of the UTF-8 body using the endpoint secret. It is sent on every request: https://connect.tryotter.com/docs/guides-webhook-authentication/
- OAuth 2.0 and an OpenAPI 3.0 spec *(paraphrase)*: https://github.com/api-evangelist/otter
- Price: Otter's POS plans start at $79/month per location *(paraphrase)*: https://www.tryotter.com/pricing . Partner API pricing was not found.

**KitchenHub: yes. Built for this case.** It markets "one consistent API" for orders and menu sync across Uber Eats, DoorDash and Grubhub, aimed at POS builders: https://www.trykitchenhub.com/developer . Sandbox, OpenAPI and webhooks *(paraphrase)*: https://www.trykitchenhub.com/pos . Pricing is per location per month, quote only, with tiers starting at "10–500 locations": https://www.trykitchenhub.com/product-info/pricing . It is unclear whether it will sell to a single store.

**ItsaCheckmate: wrong direction.** Its open API is for ordering platforms that inject orders into POS systems Checkmate already supports. It costs "$0.12 cents per transaction and capped at $15/month/location": https://openapi-itsacheckmate.readme.io/page/faq . A custom POS would need Checkmate to build a connector.

**Chowly: partner-gated.** It connects 150+ apps to 50+ named POS systems. API access is per location and partner-gated *(paraphrase)*: https://github.com/api-evangelist/chowly . Minimum about $35/month per location plus setup *(paraphrase, third-party)*: https://zay-os.com/how-much-does-chowly-cost

**Cuboh: partner-gated.** Partner APIs are provisioned after QA certification through integrations@cuboh.com. SaaS from about $80 to $119/month *(paraphrase)*: https://github.com/api-evangelist/cuboh , https://www.capterra.com/p/199007/Cuboh/

**Olo Rails: enterprise.** Two-way menu sync with 15+ marketplaces into the POS. Unpublished pricing, estimated around $1,000/month plus about $3,000 setup *(paraphrase, third-party)*: https://restauranttools.ai/tools/olo . It integrates with Aloha, Brink, Micros, Xpient and OloCloud *(paraphrase)*: https://olosupport.zendesk.com/hc/en-us/articles/115005664963-Rails-Overview . Not a fit.

**Honest assessment.** A one-store shop cannot get direct DoorDash or Uber Eats Marketplace API access in any reasonable time. Both are built for POS vendors with many merchants. Middleware is the only realistic path to inject orders. Even middleware wants a certified *partner*, and certification is sized for a POS company. The cheap fallback is the marketplace tablets plus manual entry. The middle option is a middleware product that already supports a POS you could mirror from (for example, Square), with our app reading from that POS. That trades purity for zero certification.

---

## Part B. Delivery-as-a-service (orders on OUR site, courier delivers)

### B1. DoorDash Drive API (v2)

**Signup.** Self-serve for sandbox: https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/ . **Production is restricted:** "Production access to the Drive API is currently restricted, and we cannot provide a timeline for certification following development." It goes further: "If you have not completed development and submitted a production access request, we recommend pausing development." Interest goes through a form linked on the same page. This is the biggest 2025-2026 change found.

**Auth.** JWT in `Authorization: Bearer <jwt>`: https://developer.doordash.com/en-US/docs/drive/reference/JWTs
- Header: `{ "alg": "HS256", "typ": "JWT", "dd-ver": "DD-JWT-V1" }`.
- Payload: `{ "aud": "doordash", "iss": <developer_id>, "kid": <key_id>, "iat": <seconds>, "exp": <seconds> }`. `iat` cannot be in the future. `exp` is at most 1800 s after `iat`.
- Key: the `signing_secret` is base64. The official SDK decodes it with `Buffer.from(signing_secret, "base64")` before HS256 signing and sets `exp = iat + 60` (`@doordash/sdk` `lib/utils/jwt.js`).
- Base URL: `https://openapi.doordash.com/drive/v2/`.

**Endpoints** (https://developer.doordash.com/en-US/api/drive/ ):
- `POST /drive/v2/quotes`
- `POST /drive/v2/quotes/{external_delivery_id}/accept`, with optional body `tip`, `dropoff_phone_number` (SDK `DeliveryQuoteAcceptInput`)
- `POST /drive/v2/deliveries`
- `GET /drive/v2/deliveries/{external_delivery_id}`
- `PATCH /drive/v2/deliveries/{external_delivery_id}`
- `PUT /drive/v2/deliveries/{external_delivery_id}/cancel`

**Create request** (SDK `CreateDeliveryInput`; the quote input is identical):
- Required: `external_delivery_id` (pattern `[a-zA-Z0-9-._~]+`), `dropoff_address`, `dropoff_phone_number` (E.164).
- Optional: `pickup_address`, `pickup_business_name`, `pickup_phone_number`, `pickup_instructions`, `pickup_reference_tag`, `pickup_external_business_id`, `pickup_external_store_id`, `dropoff_business_name`, `dropoff_location`, `dropoff_instructions`, `dropoff_contact_given_name`, `dropoff_contact_family_name`, `dropoff_contact_send_notifications`, `dropoff_options`, `order_value` (cents), `items`, `pickup_time`, `dropoff_time`, `pickup_window`, `dropoff_window`, `contactless_dropoff`, `action_if_undeliverable`, `tip` (cents), `order_contains`, `dasher_allowed_vehicles`, `dropoff_requires_signature`, `dropoff_cash_on_delivery`, `locale`.
- `pickup_address` is optional in the schema because a stored pickup location can stand in. Send it unless you use the Business and Store APIs. The tutorial example sends `pickup_address`, `pickup_phone_number` and `order_value`: https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/

**Response** (SDK `DeliveryResponse`):
- Always present: `external_delivery_id`, `currency`, `delivery_status`, `fee` (cents).
- Optional: `tracking_url`, `support_reference`, `cancellation_reason`, `updated_at`, `pickup_time_estimated`, `pickup_time_actual`, `dropoff_time_estimated`, `dropoff_time_actual`, `fee_components`, `tax`, `tip`, `order_value`, `dasher_id`, `dasher_name`, `dasher_dropoff_phone_number`, `dasher_pickup_phone_number`, `dasher_location`, `dasher_vehicle_make`, `dasher_vehicle_model`, `dasher_vehicle_year`, `dropoff_verification_image_url`.

**`delivery_status` values.** The docs list `created`, `confirmed`, `enroute_to_pickup`, `arrived_at_pickup`, `picked_up`, `enroute_to_dropoff`, `arrived_at_dropoff`, `delivered`, `cancelled`. A delivery can return to `created` if the Dasher unassigns: https://developer.doordash.com/en-US/docs/drive/reference/delivery_statuses . The SDK enum also has `quote`, `enroute_to_return`, `arrived_at_return`, `returned`.

**`cancellation_reason` values** (SDK): `cancelled_by_creator`, `failed_to_process_payment`, `failed_to_assign_and_refunded`, `failed_to_pickup`, `failed_to_deliver`, `failed_to_return`.

**Webhooks.** The `event_name` values are (https://developer.doordash.com/en-US/docs/drive/reference/webhooks/ ):
- Main flow: `DASHER_CONFIRMED`, `DASHER_CONFIRMED_PICKUP_ARRIVAL`, `DASHER_PICKED_UP`, `DASHER_CONFIRMED_DROPOFF_ARRIVAL`, `DASHER_DROPPED_OFF`, `DELIVERY_CANCELLED`.
- Returns and batching: `DELIVERY_RETURN_INITIALIZED`, `DASHER_CONFIRMED_RETURN_ARRIVAL`, `DELIVERY_RETURNED`, `DELIVERY_BATCHED`.
- Tracking events need a support request: `dasher_enroute_to_pickup`, `dasher_enroute_to_dropoff`, `dasher_enroute_to_return`.

There is no `DELIVERY_DROPPED_OFF`. The completion event is `DASHER_DROPPED_OFF`. The payload carries `event_name`, `created_at`, `external_delivery_id`, `dasher_id`, `dasher_name`, addresses, `order_value`, `fee`, `tip`, `currency`, `tracking_url`. Each event is sent "up to 3 times" until it gets `200 OK`.

**Webhook auth.** No signature. Configure one HTTPS endpoint per environment in the portal, with Basic Auth (the literal `Authorization` header value) or OAuth (client ID, secret, token URL, scope): https://developer.doordash.com/en-US/docs/drive/how_to/webhooks/ . OAuth webhooks arrived in May 2022: https://developer.doordash.com/en-US/blog/tags/new-feature/ . Compare the header in constant time, and match `external_delivery_id` to a row you created.

**Sandbox.** No real Dashers or costs. The portal's Delivery Simulator advances a delivery through its stages: https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/

**Pricing.** "$9.75" base within 5 miles, plus "$0.75 per mile" up to 15 miles. There is a "$2.75" discount if the recipient can tip and 100% of the tip goes to DoorDash. Billed per delivery by credit card: https://developer.doordash.com/en-US/docs/drive/overview/pricing_payment/ . The Drive On-Demand product page lists $6.99 to $10.99 per order *(paraphrase)*: https://merchants.doordash.com/en-us/products/drive-on-demand

### B2. Uber Direct API

**Signup.** Self-serve. Sign up at direct.uber.com, accept the terms, add billing, then copy Customer ID, Client ID and Client secret from the Developer tab. Production needs billing info and account approval, then a dashboard toggle: https://developer.uber.com/docs/deliveries/get-started . Uber targets businesses with "200+ monthly orders": https://merchants.uber.com/uber-direct.html

**Auth.** `POST https://auth.uber.com/oauth/v2/token` with `grant_type=client_credentials` and `scope=eats.deliveries`. Tokens last 2,592,000 s (30 days): https://developer.uber.com/docs/deliveries/get-started . The official SDK posts to `https://login.uber.com/oauth/v2/token` instead (`uber-direct-sdk/src/auth/index.ts`). Use the docs URL and keep it configurable.

**Endpoints.** Base `https://api.uber.com/v1/customers/{customer_id}` (SDK `src/deliveries/index.ts`):
- `POST /delivery_quotes`
- `POST /deliveries`
- `GET /deliveries/{delivery_id}`
- `GET /deliveries` (list)
- `POST /deliveries/{delivery_id}` (update)
- `POST /deliveries/{delivery_id}/cancel`, which returns `noncancelable_delivery` (400) or `delivery_not_found` (404) *(paraphrase)*: https://developer.uber.com/docs/deliveries/daas/api/v1/post-customers-customerid-deliveries-deliveryid-cancel
- `POST /deliveries/{delivery_id}/proof-of-delivery`

Delivery IDs start with `del_` and quote IDs with `dqt_`.

**Quote.** Request (SDK `DeliveryQuoteReq`): `pickup_address` and `dropoff_address` (required, JSON-encoded **strings** of `{street_address[], city, state, zip_code, country}`), plus optional lat/lng, `pickup_ready_dt`, `pickup_deadline_dt`, `dropoff_ready_dt`, `dropoff_deadline_dt`, phone numbers, `manifest_total_value`, `external_store_id`. Response: `kind`, `id`, `created`, `expires`, `fee`, `currency`, `currency_type`, `dropoff_eta`, `duration`, `pickup_duration`, `dropoff_deadline`. Quotes expire after 15 minutes: https://developer.uber.com/docs/deliveries/get-started

**Create request** (SDK `DeliveryReq`):
- Required: `pickup_name`, `pickup_address`, `pickup_phone_number`, `dropoff_name`, `dropoff_address`, `dropoff_phone_number`, `manifest_items[]`. Each manifest item has `name`, `quantity` and `size` or dimensions.
- Optional: `quote_id`, `external_id`, `external_store_id`, `manifest_reference`, `manifest_total_value` (cents), `tip` (cents), `pickup_notes`, `dropoff_notes`, `pickup_business_name`, `dropoff_business_name`, lat/lng fields, `pickup_ready_dt`, `pickup_deadline_dt`, `dropoff_ready_dt`, `dropoff_deadline_dt`, `dropoff_verification`, `undeliverable_action`, `deliverable_action`, `requires_dropoff_signature`, `requires_id`, `idempotency_key`, `test_specifications`.

**Response** (SDK `DeliveryResp`): `id`, `uuid`, `quote_id`, `status`, `complete`, `kind`, `live_mode`, `fee`, `currency`, `tip`, `tracking_url`, `courier { name, rating, vehicle_type, phone_number, location {lat,lng}, img_href }`, `courier_imminent`, `pickup`, `dropoff`, `pickup_eta`, `dropoff_eta`, `pickup_ready`, `pickup_deadline`, `dropoff_ready`, `dropoff_deadline`, `manifest`, `external_id`, `undeliverable_action` (`""`, `"returned"`, `"left_at_door"`), `undeliverable_reason`, `created`, `updated`.

**`status` values.** `pending`, `pickup`, `pickup_complete`, `dropoff`, `delivered`, `canceled`, `returned`, with `courier_imminent` signaling near pickup or dropoff: https://developer.uber.com/docs/deliveries/daas/references/api/webhooks/delivery-status-webhook . The SDK has the same enum. Spelling: Uber uses `canceled`, DoorDash uses `cancelled`.

**Webhooks.** Events: `event.delivery_status`, `event.courier_update`, `event.refund_request`, `event.shopping_progress`: https://developer.uber.com/docs/deliveries/guides/webhooks
- Status payload fields: `id`, `kind`, `customer_id`, `delivery_id`, `status`, `data` (full delivery), `created`, `live_mode`, `route_id`: https://developer.uber.com/docs/deliveries/daas/references/api/webhooks/delivery-status-webhook
- `event.courier_update` arrives every 20 s after courier assignment, with `location.lat` and `location.lng`, `delivery_id` and `data.courier`: https://developer.uber.com/docs/deliveries/daas/references/api/webhooks/courier-update-webhook

**Webhook signature.** Header `x-uber-signature` (or `x-postmates-signature` for status and courier webhooks; refund webhooks need `x-uber-signature`). The value is a hex HMAC-SHA256 of the raw body, keyed by the **Webhook Signing Key** shown when you create the webhook in the dashboard, not the client secret. Doc example: `hmac.new(signing_key.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256).hexdigest()`. Retries happen on 5xx, timeouts or network errors, at 10 s, then 30, 60, 120 s, up to 3 attempts: https://developer.uber.com/docs/deliveries/guides/webhooks

**Sandbox and Robo Courier.** Add `"test_specifications": { "robo_courier_specification": { "mode": "auto" } }` to Create Delivery. Auto mode steps every 30 s. `"custom"` mode takes timestamps (`enroute_for_pickup_at`, `pickup_imminent_at`, `pickup_at`, `dropoff_imminent_at`, `dropoff_at`): https://developer.uber.com/docs/deliveries/guides/robocourier . The sandbox is for functional testing only, not load testing: https://developer.uber.com/docs/deliveries/get-started

**Pricing.** "As low as $6.99 per delivery based on distance, speed of delivery, and region", with 0% commission: https://merchants.uber.com/uber-direct.html

---

## Fees and tax

| Channel | Ballpark | Source |
|---|---|---|
| DoorDash Marketplace | 15% Basic, 25% Plus, 30% Premier on delivery. 6% on pickup. The commission includes card processing. | https://merchants.doordash.com/en-us/pricing |
| Uber Eats Marketplace | Since 2026-03-10: Lite 15% → 20%, Plus 25%, Premium 30%, a new 30% rate for Uber One orders, pickup 6% → 7% | https://www.restaurantdive.com/news/uber-eats-increases-marketplace-fees/814294/ |
| DoorDash Drive API | $9.75 base within 5 mi, +$0.75/mi to 15 mi, −$2.75 with pass-through tipping | https://developer.doordash.com/en-US/docs/drive/overview/pricing_payment/ |
| Uber Direct | From $6.99 per delivery | https://merchants.uber.com/uber-direct.html |
| Middleware | Deliverect about $119+/mo, Chowly $35+/mo minimum, Otter POS $79+/mo, Checkmate (platform side) $0.12/order capped at $15 | See A4 |

On a $30 pizza order, a 25% commission costs $7.50. A Drive or Direct delivery costs about $7 to $10 flat, and our site keeps the customer relationship. *(Inference.)*

**Marketplace facilitator tax.** DoorDash flags `is_tax_remitted_by_doordash` and `tax_amount_remitted_by_doordash` on each order for marketplace facilitator states: https://developer.doordash.com/en-US/docs/marketplace/how_to/order_integration/ . Delivery platforms collect and remit sales tax on menu items in 30+ states, and restaurants risk paying the tax twice if they also remit it *(paraphrase)*: https://www.cohnreznick.com/insights/restaurants-marketplace-facilitator-laws-sales-tax-collection . Store a `tax_remitted_by_platform` flag per order and exclude those sales from our own tax filing. For Drive and Direct orders on our site, we are the seller and collect tax ourselves. *(Inference.)*

## 2025-2026 changes

- DoorDash Drive production access is restricted with no timeline. DoorDash advises pausing new development: https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/
- Uber Eats commissions rose on 2026-03-10 (see table).
- Uber Eats API changes: `orders.customer_order_edit` webhook (2026-07-02), `order_pickup_instructions` on accept (2025-10-22), `cancellation_reason` object on cancel (2025-08-21): https://developer.uber.com/docs/eats/api-change-log
- DoorDash no longer accepts permanent store deactivations from POS providers. Deactivations without an end date last two weeks: https://developer.doordash.com/en-US/docs/marketplace/how_to/store_and_item_status/
- Grubhub is now owned by Wonder (see A3).

---

## Comparison table

| Platform | Direction | Self-serve | Access gate | API auth | Inbound webhook auth | Thin event + GET? | Accept deadline |
|---|---|---|---|---|---|---|---|
| DoorDash Marketplace | Ingest | No | Partner application + SSIO certification | JWT DD-JWT-V1, HS256 | Basic header or OAuth (configured by DoorDash) | No, full order in body | 3 to 8 min (async) |
| Uber Eats Marketplace | Ingest | No | Written approval, allow-listing | OAuth2 client credentials (+ auth code for provisioning) | `X-Uber-Signature` hex HMAC-SHA256, key = client secret | Yes (`resource_href`) | 11.5 min |
| Grubhub | Ingest | No | Partner onboarding + pilot *(paraphrase)* | HMAC request signing *(paraphrase)* | Basic or webhook auth *(paraphrase)* | Unknown | Unknown |
| Deliverect | Ingest (all marketplaces) | No | Partner + certification | OAuth2 client credentials, scope `genericPOS` | `x-server-authorization-hmac-sha256` hex HMAC-SHA256 | No, full order | Status 20 expected; deadline not found |
| Otter | Ingest (all marketplaces) | No | Certification with Otter rep | OAuth 2.0 *(paraphrase)* | `X-HMAC-SHA256` **base64** HMAC-SHA256 | Not confirmed | Not found |
| KitchenHub | Ingest (all marketplaces) | Unclear | Quote, 10+ location tiers | Token + refresh *(paraphrase)* | Not found | Not found | Not found |
| DoorDash Drive | Dispatch | Sandbox yes, production restricted | Production request form | JWT DD-JWT-V1, HS256, base64 secret, exp ≤ 30 min | Basic header or OAuth. No signature. | No, full payload | n/a |
| Uber Direct | Dispatch | Yes | Billing + account approval | OAuth2 client credentials, scope `eats.deliveries` | `x-uber-signature` / `x-postmates-signature` hex HMAC-SHA256, key = webhook signing key | No, full `data` | n/a |

---

## Recommendations for this pizzeria

1. **Build Uber Direct first (delivery-as-a-service).** It is the only path that is self-serve end to end today. It has a documented HMAC webhook, a Robo Courier sandbox and flat pricing from $6.99. Model the adapter on the `DeliveryReq` and `DeliveryResp` fields above. Verify `x-uber-signature` against the raw request body before parsing JSON. Watch the "200+ monthly orders" target and confirm it is not a hard minimum.
2. **Build DoorDash Drive second, behind the same `DeliveryProvider` interface.** The sandbox is free and the API is clean, but production is restricted. Submit the production request form now, and do not block launch on it. Use a status mapper that handles both `cancelled` (DoorDash) and `canceled` (Uber). Map DoorDash `event_name` and Uber `status` into one internal enum, for example `pending → assigned → at_pickup → picked_up → at_dropoff → delivered | cancelled | returned`.
3. **For marketplace orders, keep the tablets at launch, then evaluate one middleware.** Direct DoorDash, Uber Eats and Grubhub POS APIs are partner programs built for POS companies, so they are not realistic for one store. If tablet hell becomes the main pain, contact Deliverect first (best public docs, clear HMAC, integer status codes, `orderType` enum) and Otter second. Ask each one directly whether it will certify a single-location custom POS and what that costs. KitchenHub is worth one email, though its tiers start at 10 locations. Skip ItsaCheckmate (wrong direction) and Olo Rails (enterprise).
4. **Design the schema for both directions now.** Use an `orders.source` enum (`web`, `doordash`, `ubereats`, `grubhub`), `source_order_id`, `source_display_id`, `tax_remitted_by_platform`, and a `deliveries` table keyed by our `external_delivery_id` / `external_id` with `provider`, `provider_delivery_id`, `status`, `fee_cents`, `tracking_url` and courier fields. Store every raw webhook with its event ID for idempotent processing. Uber Eats provides `event_id`. DoorDash Drive webhooks have no event ID, so dedupe on `external_delivery_id` + `event_name` + `created_at`.
5. **Verify before coding.** The SDK schemas date from October 2024. Before writing the adapters, re-check the Uber Direct reference and the DoorDash Drive reference in a real browser, since both render with JavaScript.

**Bottom line.** Delivery-as-a-service is buildable now. Start with Uber Direct, then add DoorDash Drive once production opens. Marketplace ingestion is a partnership problem, not a coding problem. For one pizzeria it means tablets or a certified middleware deal.
