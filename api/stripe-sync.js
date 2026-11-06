import { loadStore } from '../lib/store.js';
import { json, requireBearer } from '../lib/http.js';

// Creates a Stripe Product + Price for every variant that does not already have stripe_price_id.
// Returns the IDs so they can be written into the catalog.
export async function POST(request) {
  const denied = requireBearer(request, 'ADMIN_TOKEN');
  if (denied) return denied;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  const { catalog } = loadStore();
  const created = [];

  for (const product of catalog.products) {
    for (const variant of product.variants) {
      if (variant.stripe_price_id) {
        created.push({ sku: variant.sku, stripe_price_id: variant.stripe_price_id, status: 'already-linked' });
        continue;
      }
      const productRes = await fetch('https://api.stripe.com/v1/products', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          name: `${product.title} - ${variant.title}`,
          description: product.description || '',
          'metadata[sku]': variant.sku,
          'metadata[product_id]': product.id,
        }),
      });
      const stripeProduct = await productRes.json();
      if (!productRes.ok) {
        created.push({ sku: variant.sku, error: stripeProduct.error?.message || 'product create failed' });
        continue;
      }

      const priceRes = await fetch('https://api.stripe.com/v1/prices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          product: stripeProduct.id,
          unit_amount: String(variant.price_cents),
          currency: 'usd',
          'metadata[sku]': variant.sku,
        }),
      });
      const price = await priceRes.json();
      if (!priceRes.ok) {
        created.push({ sku: variant.sku, stripe_product_id: stripeProduct.id, error: price.error?.message || 'price create failed' });
        continue;
      }
      created.push({ sku: variant.sku, stripe_product_id: stripeProduct.id, stripe_price_id: price.id, status: 'created' });
    }
  }

  return json({ created });
}
