import { loadStore } from '../lib/store.js';
import { json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

// Stripe Checkout. Prefers a linked Stripe Price (variant.stripe_price_id).
// Falls back to price_data so unlinked products still checkout.
export async function POST(request) {
  const limited = rateLimit(request, { limit: 20 });
  if (limited) return limited;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const { catalog } = loadStore();
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', body.success_url || 'https://fruitypuppy.com/store?success=1');
  params.set('cancel_url', body.cancel_url || 'https://fruitypuppy.com/store');
  params.set('automatic_tax[enabled]', 'false');
  params.set('shipping_address_collection[allowed_countries][0]', 'US');

  let shippingCents = 0;
  (body.items || []).forEach((item, i) => {
    const product = catalog.products.find(p => p.variants.some(v => v.sku === item.sku));
    const variant = product?.variants.find(v => v.sku === item.sku);
    if (!variant) throw new Error(`Unknown sku ${item.sku}`);
    const prefix = `line_items[${i}]`;
    const qty = String(item.quantity || 1);
    if (variant.stripe_price_id) {
      params.set(`${prefix}[price]`, variant.stripe_price_id);
      params.set(`${prefix}[quantity]`, qty);
    } else {
      params.set(`${prefix}[price_data][currency]`, 'usd');
      params.set(`${prefix}[price_data][product_data][name]`, `${product.title} - ${variant.title}`);
      params.set(`${prefix}[price_data][unit_amount]`, String(variant.price_cents));
      params.set(`${prefix}[quantity]`, qty);
    }
    if (product.fixed_shipping_cents) shippingCents = Math.max(shippingCents, product.fixed_shipping_cents);
  });

  if (shippingCents) {
    params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(shippingCents));
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    params.set('shipping_options[0][shipping_rate_data][display_name]', 'Shipping');
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return json({ error: session.error?.message || 'Stripe error' }, 500);
  return json({ url: session.url, id: session.id });
}
