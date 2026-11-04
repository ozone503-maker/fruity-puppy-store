import { loadStore } from '../lib/store.js';
import { json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

// Stripe Checkout. For production, prefer the official stripe package.
// This version builds proper application/x-www-form-urlencoded for line_items.
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
  params.set('success_url', body.success_url || 'https://brobots.space?success=1');
  params.set('cancel_url', body.cancel_url || 'https://brobots.space');
  params.set('automatic_tax[enabled]', 'false');

  (body.items || []).forEach((item, i) => {
    const product = catalog.products.find(p => p.variants.some(v => v.sku === item.sku));
    const variant = product?.variants.find(v => v.sku === item.sku);
    if (!variant) throw new Error(`Unknown sku ${item.sku}`);
    const prefix = `line_items[${i}]`;
    params.set(`${prefix}[price_data][currency]`, 'usd');
    params.set(`${prefix}[price_data][product_data][name]`, `${product.title} - ${variant.title}`);
    params.set(`${prefix}[price_data][unit_amount]`, String(variant.price_cents));
    params.set(`${prefix}[quantity]`, String(item.quantity || 1));
  });

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
