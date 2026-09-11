# Backend

A minimal Node.js server (no framework, no database) exposing one endpoint:

## POST /api/chat

Request body:

```json
{
  "message": "Hi, can I see the menu?",
  "history": [
    { "role": "user", "content": "hello" },
    { "role": "assistant", "content": "hi there" }
  ],
  "sessionId": "optional, omit on the first request"
}
```

- `message` — required, non-empty string.
- `history` — optional array of `{ role: "user" | "assistant", content: string }`. Defaults to `[]`.
- `sessionId` — optional string. Omit it on the first request; the response
  returns one to reuse on later requests so the same order state is tracked.

Response body:

```json
{
  "reply": "...",
  "sessionId": "...",
  "order": {
    "items": [],
    "orderType": null,
    "customer": { "name": null, "phone": null, "email": null },
    "pickupTime": null,
    "deliveryAddress": null,
    "addressConfirmed": false,
    "promotion": null,
    "total": 0,
    "summaryReviewed": false,
    "confirmed": false,
    "status": "building",
    "orderId": null
  }
}
```

The endpoint loads `prompts/system-prompt.md` as the system prompt and calls
the Anthropic Messages API using `ANTHROPIC_API_KEY` and `AI_MODEL` from
`.env`. It also loads `data/menu.json` and instructs the AI to only
reference items/prices found there — never invented ones.

Each session gets a structured `order` object, held in memory (a `Map`) and
keyed by `sessionId` — there is no database, so it resets whenever the
server restarts.

### Recommendations

The system prompt also tells the AI it may recommend menu items, with
rules: at most 1-2 items at a time, only ones marked `"available": true` in
the menu data, only when relevant to what the customer said, never an
invented product, and never repeated/pushed if the customer doesn't
respond to or declines a suggestion.

### Adding items to the order

The AI can call `add_item_to_order` to add a line item
(`{ itemId, quantity, size?, options? }`). The backend validates every call
against `data/menu.json` before touching the order:

- `itemId` must match a menu item that is `available`.
- If the item has a `sizes` list, a matching `size` is required — if it's
  missing or invalid, the item is **not** added and the AI is told to ask
  the customer instead of guessing.
- `options`, if given, must exactly match strings in that item's `options`
  list.

Each added line item gets its own `lineId` (e.g.
`{ lineId, itemId, name, size, quantity, options, unitPrice }`). The
current order's items are included in the system prompt on every request
so the AI knows each `lineId` and can refer back to it.

### Modifying items in the order

The AI can call `update_order_item` with
`{ lineId, quantity?, size?, options? }` to change an existing line item's
quantity, size, and/or options. At least one of those three must be given.
The same menu validation as adding applies to any new `size` or `options`,
and a `size` change is rejected if the item has no `sizes` list. An unknown
`lineId` is rejected too. On success the line item is updated in place and
`order.total` is recalculated the same way as when adding.

On any failure (bad `lineId`, invalid size/option, nothing to update)
nothing changes and the AI receives the validation reason so it can
explain or ask a follow-up question.

### Removing items / reducing quantity

The AI can call `remove_order_item` with `{ lineId, quantity? }`:

- Omit `quantity` to remove the line item entirely.
- Provide `quantity` to reduce it by that amount — if that brings the
  quantity to zero or below, the line item is removed entirely instead of
  going negative.

An unknown `lineId` or a non-positive `quantity` is rejected without
changing the order, same as the other order tools.

### Promotions

The system prompt includes only the promotions from `data/promotions.json`
where `"active": true` — inactive ones are filtered out server-side before
the AI ever sees them, so they can't be mentioned or applied. The AI can
call `apply_promotion` with `{ promotionId }` to apply one; the backend
re-checks eligibility against the current order regardless of what the AI
believes:

- `promotionId` must match a currently active promotion.
- The order must not be empty.
- Eligibility (from the promotion's `eligibility` object) is checked
  against the order: `categories` / `requires_categories` against the
  categories of items actually in the order (looked up from
  `data/menu.json`), `time_window` against the current server time, and
  `min_order_total` against the order subtotal.

On success, `order.promotion` is set and `order.total` is recalculated to
reflect the discount (see "Order total calculation" below). On failure,
nothing changes and the AI receives the specific reason (e.g. "only valid
between 14:00 and 16:00").

The applied promotion's eligibility is re-verified every time the total is
recalculated (after any add/update/remove) — if the order changes so it's
no longer eligible (e.g. the qualifying item is removed) or the promotion
becomes inactive, it's automatically cleared rather than silently kept.

### Order total calculation

`order.total` is always computed deterministically in `getOrderBreakdown()`
— the AI never calculates or states a price itself. Every input is either
menu data or plain config, never something the AI supplies:

1. **Subtotal** — sum of each line item's `(unitPrice + option surcharges)
   × quantity`, where `unitPrice` always comes from `data/menu.json` (base
   price or the selected size's price) and option surcharges are parsed
   from the `+X.XX` suffix on the option text.
2. **Discount** — if an active, eligible promotion is applied (see
   Promotions above), subtracted from the subtotal.
3. **Tax** — `TAX_RATE` (a decimal fraction from `.env`, e.g. `0.08` for
   8%) applied to the discounted subtotal. Defaults to `0` if unset.
4. **Delivery fee** — `DELIVERY_FEE` (a flat dollar amount from `.env`)
   added only when `order.orderType === "delivery"`. Defaults to `0` if
   unset, and never applies to pickup orders.

`order.total` = discounted subtotal + tax + delivery fee. This is
recalculated after every action that could change it — adding, updating,
or removing an item; applying a promotion; or switching between pickup and
delivery (which adds/removes the delivery fee immediately). The full
breakdown is also shown in the current-order summary (see below) whenever
there's a discount, tax, or delivery fee to explain, so the AI can relay
an accurate breakdown to the customer without doing any math itself.

### Pickup details

The AI can call `set_pickup_details` with `{ customerName?, pickupTime? }`
to record the customer's name (required before checkout) and an optional
requested pickup time:

- At least one of `customerName` / `pickupTime` must be given.
- Either can be omitted on a given call so already-known info doesn't need
  to be repeated — e.g. call with only `pickupTime` once the name is
  already set, or only `customerName` to update just the name.
- If the order doesn't already have a name and this call doesn't supply
  one, it's rejected: a name is required for a pickup order.

On success, `order.orderType` is set to `"pickup"`, `order.customer.name`
and/or `order.pickupTime` are updated, and any leftover delivery details
(`deliveryAddress`, `addressConfirmed`) are cleared since the order is no
longer for delivery.

### Delivery details and address confirmation

The AI can call `set_delivery_details` with `{ customerName?, address? }`
the same incremental way as pickup — both a name and a full address are
required before checkout, but either field can be omitted on a given call
if it's already set. If the order doesn't already have a name and this
call doesn't supply one, it's rejected.

On success, `order.orderType` is set to `"delivery"`, `order.pickupTime`
is cleared, and:

- If the `address` was newly set or changed, `order.addressConfirmed` is
  reset to `false` and the tool's result message explicitly instructs the
  AI to read the full address back to the customer and get their clear
  confirmation (or a correction) before it can be treated as final.
- If only `customerName` changed, the existing confirmation state is left
  alone.

The AI can then call `confirm_delivery_address` (no arguments) once the
customer has explicitly confirmed the address is correct. It fails if the
order isn't set for delivery yet or has no address to confirm; calling it
again on an already-confirmed address is a harmless no-op. If the customer
instead says the address is wrong, the AI is expected to call
`set_delivery_details` with the correction — which re-triggers the
"needs confirmation" state — rather than calling `confirm_delivery_address`.

Like `confirm_order`, this also checks a turn-start snapshot rather than
the live address: `confirm_delivery_address` only succeeds if the address
being confirmed is the exact same one that already existed *before* the
current request's tool calls ran. This stops a single model turn from
calling `set_delivery_details` and `confirm_delivery_address` back to
back — marking a brand-new, never-actually-shown address as confirmed
without the customer ever seeing or replying to it.

The system prompt tells the AI it must not call `confirm_delivery_address`
based on a vague acknowledgment ("ok", "sounds good") — only an explicit
confirmation of the address itself counts. Since checkout isn't
implemented yet, this only tracks state for now; a future checkout step
would be expected to require `addressConfirmed: true` for delivery orders.

### Telling the customer what's in their order

Every request's system prompt includes a plain-text summary of the current
order (order type, name, pickup time or delivery address if set,
quantities, sizes, options, and totals), e.g.:

```
Order type: delivery
Name: Alex
Delivery address: 123 Main St, Apt 4B (not yet confirmed)
2x Caffe Latte (Medium) with Oat milk +0.50 — $11.00
1x Butter Croissant — $3.50
Subtotal: $14.50
Promotion applied: Coffee + Pastry Bundle (-$1.50)
Tax: $1.04
Delivery fee: $2.50
Total: $16.54
Also valid for this order: Afternoon Happy Hour
```

The `Subtotal` / `Promotion applied` / `Tax` / `Delivery fee` lines only
appear when there's something to show (a discount, a non-zero tax rate, or
an active delivery fee) — a plain order with none of those just shows the
item lines and `Total`, keeping the common case concise. The
`Also valid for this order` line only appears when another active
promotion (besides the one applied, if any) is currently eligible. Any
detail not shown (e.g. no "Pickup time" or "Delivery address" line) means
it hasn't been provided yet. If the order is empty, the summary is
`The order is currently empty.` (with any pickup/delivery details already
set shown above it). The system prompt explicitly tells the AI every price
and the total are calculated by the system and it must never do the math
or state a price itself — it should always read them from this summary or
a tool result. The AI is told to use this summary whenever the customer
asks what's in their order, rather than reading the raw order JSON (which
is still included separately, only for `lineId` lookups when calling
`update_order_item` / `remove_order_item`).

### Order summary before checkout

The AI can call `get_order_summary` (no arguments) to generate a complete,
structured snapshot of the order, meant for a final review before
checkout:

```json
{
  "items": [
    { "name": "Caffe Latte", "size": "Medium", "quantity": 2, "customizations": ["Oat milk +0.50"], "lineTotal": 11 },
    { "name": "Butter Croissant", "size": null, "quantity": 1, "customizations": [], "lineTotal": 3.5 }
  ],
  "fulfillment": {
    "type": "delivery",
    "name": "Alex",
    "pickupTime": null,
    "deliveryAddress": "123 Main St, Apt 4B",
    "addressConfirmed": true
  },
  "appliedPromotion": { "id": "promo-pastry-bundle", "name": "Coffee + Pastry Bundle", "discount": 1.5 },
  "otherValidPromotions": [],
  "totals": { "subtotal": 14.5, "discount": 1.5, "tax": 1.04, "deliveryFee": 2.5, "total": 16.54 }
}
```

Every field is computed by `getOrderSummary()` from order state, menu
data, and promotions data — nothing is left for the AI to assemble or
calculate. `fulfillment.pickupTime` / `deliveryAddress` /
`addressConfirmed` are only populated for the matching `orderType` (e.g. a
pickup order always has `deliveryAddress: null`). `otherValidPromotions`
lists any other active promotion (besides the applied one) that's
currently eligible for the order, using the same eligibility check as
`apply_promotion`.

The system prompt tells the AI to call this tool — not build a summary
from memory — whenever the customer wants to review the whole order or
says they're ready to check out, present everything it returns, and ask
for confirmation. Calling it also marks `order.summaryReviewed = true` (see
"Confirmation gate" below).

### Confirmation gate

The order is never finalized just because the AI says so in conversation.
Finalizing means calling `confirm_order` (no arguments), and the backend
enforces every structural precondition itself — the AI's judgment alone is
never trusted:

- The order must have at least one item.
- `orderType` and `customer.name` must be set (via `set_pickup_details` /
  `set_delivery_details`).
- For a delivery order, `deliveryAddress` must be set **and**
  `addressConfirmed` must be `true`.
- **The order summary must have been reviewed in an *earlier* turn.** Every
  order-changing action (`add_item_to_order`, `update_order_item`,
  `remove_order_item`, `apply_promotion`, `set_pickup_details`,
  `set_delivery_details`, `confirm_delivery_address`) resets
  `order.summaryReviewed` back to `false` via a shared `markOrderChanged()`
  call, and `get_order_summary` sets it back to `true`. `confirm_order`
  doesn't check that live flag directly, though — it checks a snapshot of
  it taken at the very start of `handleChat`, before any tool call in the
  current request has run. That snapshot can only be `true` if
  `get_order_summary` succeeded in a *previous* request with nothing
  changing since — i.e. the customer's message actually triggered this
  `confirm_order` call, not the same model turn that generated the summary.
  This closes an otherwise-real gap: without the snapshot, a single model
  response containing both `get_order_summary` and `confirm_order` tool
  calls would satisfy a same-turn `summaryReviewed` check and finalize the
  order having never actually shown anything to the customer.

If any of those fail, `confirm_order` returns an error and nothing
changes. If they all pass, `order.confirmed` is set to `true` and
`order.status` becomes `"confirmed"`.

What the backend *cannot* verify is whether the customer's reply was an
actually unambiguous "yes" — that's a natural-language judgment, not
something derivable from the request. That half of the gate is enforced
through the system prompt instead: the AI is told only to call
`confirm_order` after a clear, explicit confirmation (e.g. "yes", "that's
correct"), and that vague replies like "ok", "sounds good", or silence
must never be treated as confirmation. Combined, this means: the system
guarantees the order can't be finalized on stale or incomplete data, and
the AI is directed to guarantee it isn't finalized on an ambiguous reply
either.

If the order is later changed again after being confirmed (e.g. the
customer adds one more item), `markOrderChanged()` also resets
`order.confirmed` to `false` and `order.status` back to `"building"` — a
past confirmation doesn't carry over to a different order, so
`confirm_order` must be called again (after a fresh summary) to
re-finalize it.

### Saving confirmed orders

The moment `confirm_order` passes every gate check above and transitions
`order.confirmed` from `false` to `true`, it also calls
`saveConfirmedOrder(order, sessionId)`, which appends a record to
`data/orders.json` (a plain JSON array — still no database):

```json
{
  "orderId": "4f3bb753-88fd-4205-aec9-fdbb788eb22a",
  "sessionId": "3ad4bb1f-3b2d-41b6-9db3-a8cd19635b26",
  "status": "NEW",
  "confirmedAt": "2026-08-18T09:46:16.941Z",
  "items": [{ "name": "Caffe Latte", "size": "Medium", "quantity": 1, "customizations": [], "lineTotal": 5 }],
  "fulfillment": { "type": "pickup", "name": "Robin", "pickupTime": null, "deliveryAddress": null, "addressConfirmed": null },
  "appliedPromotion": null,
  "totals": { "subtotal": 5, "discount": 0, "tax": 0, "deliveryFee": 0, "total": 5 }
}
```

- `orderId` is a fresh `crypto.randomUUID()`, unique per confirmation, also
  stored back onto `order.orderId` for the session.
- `confirmedAt` is an ISO timestamp taken at the moment of saving.
- The `items` / `fulfillment` / `appliedPromotion` / `totals` fields reuse
  `getOrderSummary()` — the exact same structured data the customer just
  reviewed, so nothing new is computed or reshaped for storage.

**This only ever runs from inside `confirm_order`'s already-gated success
path** — the same code path that just enforced a complete order, a
confirmed delivery address (if applicable), and a fresh, unmodified
summary. `saveConfirmedOrder()` additionally throws if it's ever called
with an order whose `status` isn't already `"confirmed"`, as a hard
invariant: a draft ("building") order can never be written to
`data/orders.json`. Calling `confirm_order` again on an already-confirmed
order (the idempotent "already confirmed" case) does not write a second
record — the file only grows on an actual unconfirmed→confirmed
transition.

Checkout (payment/fulfillment) itself is still not implemented — this only
tracks and persists whether the order has been reviewed and confirmed.

## GET /api/orders

Returns every order currently in `data/orders.json`:

```json
{ "orders": [ { "orderId": "...", "status": "NEW", "...": "..." } ] }
```

Used by the staff dashboard (`frontend/dashboard.html`) to list orders.

## PATCH /api/orders/:orderId

Updates one order's `status`. Body: `{ "status": "PREPARING" }`. Valid
values are `NEW`, `PREPARING`, `READY`, `COMPLETED`, `CANCELLED`
(`STAFF_ORDER_STATUSES`). Returns `400` for an invalid status, `404` if no
order matches `orderId`, or `{ "order": {...} }` with the updated order on
success. This is a direct edit to `data/orders.json` — it doesn't touch any
in-memory chat session, since a confirmed order is decoupled from whatever
happens in the conversation afterward.

## Running it

Requires Node 18+ (uses the built-in `fetch`).

```bash
cd backend
npm start
```

Copy `.env.example` to `.env` in the project root first and fill in a real
`ANTHROPIC_API_KEY` and `AI_MODEL`, otherwise the endpoint responds with a
500 "not configured" error.
