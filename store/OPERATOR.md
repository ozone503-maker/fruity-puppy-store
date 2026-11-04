# Store Operator Guide (for bots)

## Env vars needed on Vercel
- STRIPE_SECRET_KEY
- PRINTIFY_TOKEN (Personal Access Token from Printify dashboard > My Account > API)
- PRINTIFY_SHOP_ID (from GET /shops.json or dashboard)
- Optional: PRINTIFY_WEBHOOK_SECRET

## Adding a Printify product
1. Upload design via PrintifyClient.uploadImage (URL or base64).
2. Create product with blueprint_id, print_provider_id, variants (id, price in cents, is_enabled), print_areas with placeholders.images[{id, x, y, scale, angle}].
3. After create, GET the product to pull mockup images.src.
4. Add to store/catalog.json with fulfiller: "printify", and on variants add printify_product_id and printify_variant_id.
5. Commit the catalog change.

## Order flow
On paid Stripe session, call fulfillOrder with the order object that includes items with printify_* ids and shipping address.
Webhook at /api/printify-webhook receives tracking and calls recordTracking.

## Merch factory
See tools/merch-factory.js for a starter script to upload + create + sync mockups.

Default fulfiller is warehouse. Set product.fulfiller to "printify" for POD items.
