# Store Operator Guide (for bots and humans)

Secrets live **only** in environment variables (Vercel project settings, or a local
`.env` that is git-ignored). Never commit them, paste them into code, or log them.

## 1. Environment variables to set in Vercel

Vercel → Project → Settings → Environment Variables. Set for **Production** (and
Preview if you test there). Redeploy after changing any of them.

| Variable | Required | What it is / where to get it |
| --- | --- | --- |
| `PRINTIFY_API_TOKEN` | yes (Printify) | Printify personal access token: printify.com → My Profile → Connections → Generate token. Scopes needed: `shops.read`, `catalog.read`, `products.read`, `products.write`, `orders.read`, `orders.write`, `uploads.write`, `webhooks.read`, `webhooks.write`. Tokens expire after 1 year. (`PRINTIFY_TOKEN` is still accepted as a legacy alias.) |
| `PRINTIFY_SHOP_ID` | yes (Printify) | Numeric shop id. Get it with `curl -s https://api.printify.com/v1/shops.json -H "Authorization: Bearer $PRINTIFY_API_TOKEN" -H "User-Agent: fruity-puppy-store"` and use the `id` of the API ("custom integration") shop. |
| `PRINTIFY_WEBHOOK_SECRET` | yes (tracking webhook) | Any random string, e.g. `openssl rand -hex 20`. The same value is given to Printify when the webhook is registered (step 4). `/api/printify-webhook` rejects every request (503) until it is set, and 401s anything not signed with it. |
| `STRIPE_SECRET_KEY` | yes (checkout) | Stripe Dashboard → Developers → API keys. Use `sk_test_...` until you are ready to take real money, then `sk_live_...` (or a restricted key with Checkout Sessions write). |
| `STRIPE_WEBHOOK_SECRET` | yes (order routing) | `whsec_...` signing secret shown when you add the webhook endpoint in step 4. `/api/stripe-webhook` rejects everything until it is set. Test and live mode endpoints have different secrets. |
| `STORE_SITE_URL` | yes (checkout) | Public https origin of the storefront, no trailing slash, e.g. `https://brobots.space` (later `https://fruitypuppy.com`). Used to build Stripe `success_url` / `cancel_url`. |
| `STORE_SUCCESS_URL`, `STORE_CANCEL_URL` | optional | Override the success/cancel URLs completely. `success_url` may contain `{CHECKOUT_SESSION_ID}`. |
| `STORE_DIR` | optional | Alternate directory for `config.json` / `catalog.json` (tests/tools only). |

Checkout ignores any `success_url`/`cancel_url` sent by the browser.

## 2. Create the first live Printify product (unpublished)

Run locally (or from any box with the repo) with the two Printify vars exported in
your shell. Nothing is published and no order is placed.

```bash
export PRINTIFY_API_TOKEN=...   # do not commit; do not echo
export PRINTIFY_SHOP_ID=...

# a) Rehearse with no network writes (works even without a token):
npm run merch:dry

# b) Find a blueprint, then its print providers, then preview real variants:
node tools/merch-factory.js --list-blueprints --search "heavy cotton tee"
node tools/merch-factory.js --list-providers --blueprint 6
node tools/merch-factory.js --blueprint 6 --provider <PROVIDER_ID> --colors "Black" --sizes S,M,L,XL --title "Fruity Puppy Tee"

# c) Create it in Printify as an UNPUBLISHED product and add it to store/catalog.json:
node tools/merch-factory.js --create \
  --blueprint 6 --provider <PROVIDER_ID> \
  --colors "Black" --sizes S,M,L,XL \
  --image https://<public-https-url-to-design>.png \
  --title "Fruity Puppy Tee" --description "Fresh fruit energy, printed on demand." \
  --tags "merch,tee,fruity puppy"
```

What `--create` does:
1. Uploads the design (`POST /v1/uploads/images.json`).
2. Creates the product (`POST /v1/shops/{shop_id}/products.json`) with only the selected variants enabled, at a provisional price.
3. Reads Printify's wholesale `cost` for each variant and sets **retail = cost × 1.20, rounded up to the next $x.99** (`PUT /v1/shops/{shop_id}/products/{id}.json`).
4. Polls the product for mockup images (up to `--mockup-wait` seconds, default 60).
5. Upserts `store/catalog.json` (dedupes on `printify_product_id`) with `fulfiller: "printify"`, the mockup URLs, blueprint/provider ids, and per-variant `sku`, `size`, `color`, `price_cents`, `cost_cents`, `printify_product_id`, `printify_variant_id`.

Then: review the product in the Printify dashboard, `git diff store/catalog.json`,
commit, and deploy. Do **not** re-run `--create` for the same design (it creates a
second Printify product); edit prices in `catalog.json` + Printify instead.
Flags: `--variant-ids 17427,17428`, `--position back`, `--max-variants 24`,
`--image-id <existing upload id>`, `--include-out-of-stock`, `--id <url-slug>`.

## 3. Order flow

1. Browser `POST /api/checkout` with `{ items: [{ sku, quantity }] }`.
   Prices come only from `store/catalog.json` (integer cents). The Stripe session
   carries `catalog_product_id`, `sku`, `fulfiller`, `printify_product_id`, and
   `printify_variant_id` both in session `metadata` (`item_0`, `item_1`, ...) and on each
   line item's product metadata.
2. Stripe calls `POST /api/stripe-webhook` (`checkout.session.completed` /
   `checkout.session.async_payment_succeeded`). The signature is verified, items are
   grouped by fulfiller, and `fulfillOrder` runs for each group.
3. The Printify adapter creates the Printify order with `external_id` = Stripe
   session id. It throws (Stripe will retry) on any missing product/variant id,
   token, shop id, or address field; it never guesses. With
   `"send_to_production": false` (the default in `store/config.json`) the order waits
   **on hold** in Printify for a human to approve. Only set it to `true` once you have
   watched a few orders go through.
4. Printify calls `POST /api/printify-webhook` on shipment; it is signature-checked
   and the tracking is recorded against our order id.

## 4. Register webhooks (one time, after deploy)

Stripe: Dashboard → Developers → Webhooks → Add endpoint
`https://<STORE_SITE_URL host>/api/stripe-webhook`, events
`checkout.session.completed` and `checkout.session.async_payment_succeeded`.
Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Printify (needs `webhooks.write`):

```bash
for topic in order:shipment:created order:shipment:delivered; do
  curl -s -X POST "https://api.printify.com/v1/shops/$PRINTIFY_SHOP_ID/webhooks.json" \
    -H "Authorization: Bearer $PRINTIFY_API_TOKEN" -H "Content-Type: application/json" \
    -H "User-Agent: fruity-puppy-store" \
    -d "{\"topic\":\"$topic\",\"url\":\"https://<host>/api/printify-webhook\",\"secret\":\"$PRINTIFY_WEBHOOK_SECRET\"}"
done
```

## 5. Checks

```bash
npm test          # unit tests (no network, no secrets needed)
npm run lint      # node --check on every api/lib/tools/test file
npm run merch:dry # merch factory rehearsal
```

## Known gaps

- `lib/orders.js` keeps tracking in memory only; it does not survive Vercel cold
  starts. Wire it to a durable store before showing tracking to customers.
- Stripe webhook retries could create a duplicate Printify order if the first
  attempt partially succeeded; check Printify for duplicate `external_id`s.
- `public/cart.js` is a minimal localStorage cart (badge click = checkout); there is
  no cart review page or success page beyond `/?checkout=success` yet.

Default fulfiller is `warehouse` (manual). Products with `"fulfiller": "printify"` go to Printify.
