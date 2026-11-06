# Orders and payments

Payment state and fulfillment state are separate on every order.

- payment: `pending` → `paid` | `failed` | `expired`
- fulfillment: `not_ready` → `queued` (manual/warehouse) or `handoff_pending` (has Printify items) → `shipped`; `cancelled` if payment fails.

## Flow
1. `POST /api/checkout` validates SKUs and integer quantities (max `cart.max_qty_per_item`), builds redirect URLs from the brand's `allowed_origins` only, and tags each line with its SKU.
2. Stripe calls `POST /api/stripe-webhook` (signature-verified). Handled: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`. Lines are re-read from Stripe, not the browser. Event ids are claimed once (idempotent); on any failure the claim is released and a 5xx is returned so Stripe retries (up to 3 days). Resend from the Stripe dashboard to recover.
3. `/confirmation` asks `GET /api/order-status?session_id=…` and only says "Order confirmed" when the webhook recorded `paid`. That endpoint returns state only, no customer data.
4. Operator queue: `GET /api/admin-orders?fulfillment=queued` with `Authorization: Bearer $ADMIN_TOKEN`.
5. Nothing is sent to Printify automatically and no emails are sent.

## Required configuration (all fail closed when missing)
- `STRIPE_WEBHOOK_SECRET` — from the Stripe webhook endpoint `https://fruity-puppy-store.vercel.app/api/stripe-webhook`.
- Order store: Upstash Redis REST, `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).
- `ADMIN_TOKEN` — long random string; also guards `POST /api/stripe-sync`.
- `PRINTIFY_WEBHOOK_SECRET` — the `secret` used when registering the Printify webhook.

Tests: `npm test` (local mocks and locally signed payloads only).
