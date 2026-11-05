# Store Kit

One store program. Every brand gets the same shop.

- Brobots: `brobots.space/store` → `store/brands/brobots/catalog.json`
- Fruity Puppy: `fruitypuppy.com/store` → `store/catalog.json`
- Kudoken: `kudoken.space/store` → `store/brands/kudoken/catalog.json`
- New brand: add `store/brands/<brand>/` and mount `/store`. Do not rebuild the shop.

Bots: read `store/OPERATOR.md` before touching anything.

## What every store already has

These are part of the program. They are not rebuilt per brand.

- **Cart** — drawer plus `/cart`. Quantity, remove, subtotal. One cart per brand.
- **Suggested products** — from `pairs` on the product, otherwise other products in that brand's catalog. Shown on the product page, the drawer, and the cart page.
- **Order confirmation** — `/confirmation` after Stripe. Cart clears. Receipt line shown.
- **Checkout** — Stripe. Uses `stripe_price_id` when linked, otherwise price data.

A new brand inherits all of this. The only thing that changes is the catalog and the config.

## Mockups

When you add a product or expand a design, copy the mockups from the original catalog onto the new listing. Do not leave a new product on a logo or an empty `images` array if the original already has mockups. See `store/OPERATOR.md`.

## Standard catalog issue

**Standard catalog issue** is a fixed set of products. When someone says “standard catalog issue”, “standard issue”, or “add the standard catalog,” expand it into **all six** of these, using the same design on every one:

| Key | Product | What it is |
|-----|---------|------------|
| `tee` | T-shirt | Unisex Softstyle / staple tee (lightweight) |
| `long-sleeve` | Long-sleeved t-shirt | Unisex long sleeve tee |
| `hoodie-beach` | Beach hoodie | Lightweight 6–8 oz, after-sun style |
| `hoodie-kilauea` | Kīlauea hoodie | Standard hooded sweatshirt |
| `hoodie-mauna-kea` | Mauna Kea hoodie | Thick and expensive |
| `blanket` | Blanket | Velveteen plush or Sherpa fleece blanket |

Hoodie weights: **Beach** (light 6–8 oz) → **Kīlauea** (standard) → **Mauna Kea** (thick, premium).

That is the whole standard set. Do not drop any of them. Do not invent extra items unless the user named them.

### How to expand a request

If the user says:

> take this design, make me a trucker hat, a duffel bag and standard catalog issue

You create **8 products** from that one design:

1. trucker hat (named extra)
2. duffel bag (named extra)
3. tee
4. long-sleeve
5. Beach hoodie
6. Kīlauea hoodie
7. Mauna Kea hoodie
8. blanket

Named extras are in addition to the standard set. They are not a replacement for it.

### Rules

- Same design, same title stem, different product type on each listing.
- Copy mockups from the original catalog product onto every new listing.
- Resolve real Printify `blueprint_id` and `print_provider_id` at create time. Do not hardcode stale IDs.
- Prefer Printify Choice / a US provider when both exist.
- Enable the common size run (S–XL minimum on apparel; all offered sizes on the blanket).
- Write every product into the brand catalog (`store/brands/<brand>/catalog.json`, or `store/catalog.json` for Fruity Puppy) with `fulfiller: "printify"` and the Printify product/variant IDs.
- Commit. The store deploys from the catalog file.

Machine-readable copy: `store/standard-catalog.json`.
