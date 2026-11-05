# Store Operator Guide (for bots)

## Env vars needed on Vercel
- STRIPE_SECRET_KEY
- PRINTIFY_TOKEN (Personal Access Token from Printify dashboard > My Account > API)
- PRINTIFY_SHOP_ID (from GET /shops.json or dashboard)
- Optional: PRINTIFY_WEBHOOK_SECRET

## Duplicatable program

One deployment. Many brands. Do not rebuild the shop for a new brand.

Every store already has:

- Cart (drawer + `/cart`), one cart per brand
- Suggested products from `pairs`, else other products in that catalog
- Order confirmation at `/confirmation`
- Stripe checkout

To add a brand: create `store/brands/<brand>/catalog.json` and `config.json`, then mount `/store` with `?brand=<brand>` or hostname detection. Cart, suggestions, and confirmation come with it.

## Standard catalog issue

Read `README.md` and `store/standard-catalog.json`.

**Standard catalog issue** always expands to all six: tee, long-sleeve, Beach hoodie, Kīlauea hoodie, Mauna Kea hoodie, blanket.

Hoodie weights:
- Beach — lightweight 6–8 oz, after-sun style
- Kīlauea — standard hooded sweatshirt
- Mauna Kea — thick and expensive

If the user names extra products (trucker hat, duffel bag, etc.) plus standard catalog issue, create the extras **and** all six standard items. Extras do not replace the standard set.

Example: "take this design, make me a trucker hat, a duffel bag and standard catalog issue" → 8 products.

## Adding a Printify product
1. Upload design via PrintifyClient.uploadImage (URL or base64).
2. Create product with blueprint_id, print_provider_id, variants (id, price in cents, is_enabled), print_areas with placeholders.images[{id, x, y, scale, angle}].
3. After create, GET the product to pull mockup images.src.
4. Add to the brand catalog with fulfiller: "printify", and on variants add printify_product_id and printify_variant_id.
   - Brobots: store/brands/brobots/catalog.json
   - Fruity Puppy: store/catalog.json
5. Commit the catalog change.

Resolve blueprint and provider IDs live from the Printify catalog. Do not hardcode stale IDs.

## Order flow
On paid Stripe session, call fulfillOrder with the order object that includes items with printify_* ids and shipping address.
Webhook at /api/printify-webhook receives tracking and calls recordTracking.

## Merch factory
See tools/merch-factory.js for a starter script to upload + create + sync mockups.

Default fulfiller is warehouse. Set product.fulfiller to "printify" for POD items.
