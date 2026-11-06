import { loadStore } from '../lib/store.js';
import { json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

const DEFAULT_MAX_QTY = 20;
const MAX_LINES = 50;

// Redirects are built on the server from the brand's allowed_origins only.
// The client may hint which allowed origin and whether the store is mounted at /store.
export function redirectUrls(config, brand, hint) {
  const allowed = config.allowed_origins || [];
  let origin = allowed[0];
  let base = '/store';
  try {
    const u = new URL(hint);
    if (allowed.includes(u.origin)) {
      origin = u.origin;
      base = u.pathname.startsWith('/store/') ? '/store' : '';
    }
  } catch {}
  const q = brand ? `?brand=${encodeURIComponent(brand)}` : '';
  const sep = q ? '&' : '?';
  return {
    success_url: `${origin}${base}/confirmation${q}${sep}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${base}/cart${q}`,
  };
}

export function validateItems(body, catalog, maxQty) {
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) return { error: 'Cart is empty' };
  if (items.length > MAX_LINES) return { error: 'Too many items' };
  const merged = new Map();
  for (const item of items) {
    const sku = typeof item?.sku === 'string' ? item.sku : '';
    const qty = item?.quantity === undefined ? 1 : item.quantity;
    if (!Number.isInteger(qty) || qty < 1) return { error: 'Invalid quantity' };
    let found = null;
    for (const p of catalog.products) {
      const v = p.variants.find(x => x.sku === sku);
      if (v) { found = { product: p, variant: v }; break; }
    }
    if (!found || found.variant.active === false) return { error: 'An item in your cart is no longer available' };
    const total = (merged.get(sku)?.quantity || 0) + qty;
    if (total > maxQty) return { error: `Maximum ${maxQty} per item` };
    merged.set(sku, { ...found, quantity: total });
  }
  return { lines: [...merged.values()] };
}

export async function POST(request, { fetchImpl = fetch } = {}) {
  const limited = rateLimit(request, { limit: 20 });
  if (limited) return limited;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Checkout is unavailable right now' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const brand = new URL(request.url).searchParams.get('brand') || undefined;
  let store;
  try { store = loadStore(brand); } catch { return json({ error: 'Unknown store' }, 400); }
  const { config, catalog } = store;

  const check = validateItems(body, catalog, config.cart?.max_qty_per_item || DEFAULT_MAX_QTY);
  if (check.error) return json({ error: check.error }, 400);

  const urls = redirectUrls(config, brand, body.success_url);
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', urls.success_url);
  params.set('cancel_url', urls.cancel_url);
  params.set('automatic_tax[enabled]', 'false');
  params.set('shipping_address_collection[allowed_countries][0]', 'US');
  params.set('metadata[brand]', brand || '');

  let shippingCents = 0;
  check.lines.forEach(({ product, variant, quantity }, i) => {
    const prefix = `line_items[${i}]`;
    if (variant.stripe_price_id) {
      params.set(`${prefix}[price]`, variant.stripe_price_id);
    } else {
      params.set(`${prefix}[price_data][currency]`, config.currency || 'usd');
      params.set(`${prefix}[price_data][product_data][name]`, `${product.title} - ${variant.title}`);
      params.set(`${prefix}[price_data][product_data][metadata][sku]`, variant.sku);
      params.set(`${prefix}[price_data][unit_amount]`, String(variant.price_cents));
    }
    params.set(`${prefix}[quantity]`, String(quantity));
    if (product.fixed_shipping_cents) shippingCents = Math.max(shippingCents, product.fixed_shipping_cents);
  });

  if (shippingCents) {
    params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(shippingCents));
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    params.set('shipping_options[0][shipping_rate_data][display_name]', 'Shipping');
  }

  let res, session;
  try {
    res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    session = await res.json();
  } catch {
    return json({ error: 'Checkout is unavailable right now' }, 502);
  }
  if (!res.ok) {
    console.error('Stripe checkout error', session?.error?.type, session?.error?.code);
    return json({ error: 'Checkout could not be started' }, 502);
  }
  return json({ url: session.url, id: session.id });
}
