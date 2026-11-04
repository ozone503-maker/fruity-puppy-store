// Zero-dependency Stripe helpers: correct application/x-www-form-urlencoded
// encoding of nested params, and Checkout Session construction from the catalog.
// STRIPE_SECRET_KEY is read only from env by callers and never logged.

const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Encode a nested object the way Stripe expects:
 *   { line_items: [{ price_data: { unit_amount: 100 } }] }
 *   -> line_items[0][price_data][unit_amount]=100
 * undefined/null values are skipped; booleans become "true"/"false".
 */
export function encodeStripeForm(params) {
  const out = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${key}[${i}]`));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    } else if (typeof value === 'boolean') {
      out.append(key, value ? 'true' : 'false');
    } else {
      out.append(key, String(value));
    }
  };
  walk(params, '');
  return out.toString();
}

export class CheckoutError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'CheckoutError'; this.status = status; }
}

/** Resolve success/cancel URLs from env/config only (never from the request body). */
export function checkoutUrls(config = {}, env = process.env) {
  const site = (env.STORE_SITE_URL || config.site_url || '').replace(/\/+$/, '');
  const success = env.STORE_SUCCESS_URL || config.checkout?.success_url
    || (site && `${site}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  const cancel = env.STORE_CANCEL_URL || config.checkout?.cancel_url || (site && `${site}/?checkout=cancel`);
  if (!success || !cancel) {
    throw new CheckoutError('Checkout URLs not configured: set STORE_SITE_URL (or STORE_SUCCESS_URL and STORE_CANCEL_URL)', 500);
  }
  for (const u of [success, cancel]) {
    let parsed;
    try { parsed = new URL(u.replace('{CHECKOUT_SESSION_ID}', 'x')); } catch { throw new CheckoutError(`Invalid checkout URL: ${u}`, 500); }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new CheckoutError(`Checkout URL must be https: ${u}`, 500);
  }
  return { success, cancel };
}

function isInt(n) { return Number.isInteger(n) && n >= 0; }

/**
 * Build Stripe Checkout Session params from cart items, validating every SKU,
 * quantity and price against the server-side catalog.
 */
export function buildCheckoutSessionParams({ items, catalog, config = {}, env = process.env }) {
  if (!Array.isArray(items) || !items.length) throw new CheckoutError('Cart is empty');
  const maxQty = config.cart?.max_qty_per_item || 20;
  const currency = String(config.currency || 'usd').toLowerCase();
  if (items.length > 40) throw new CheckoutError('Too many items');

  // Merge duplicate SKUs.
  const merged = new Map();
  for (const raw of items) {
    const sku = typeof raw?.sku === 'string' ? raw.sku.trim() : '';
    if (!sku) throw new CheckoutError('Each item needs a sku');
    const qty = raw.quantity === undefined ? 1 : Number(raw.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new CheckoutError(`Invalid quantity for ${sku}`);
    merged.set(sku, (merged.get(sku) || 0) + qty);
  }

  const lineItems = [];
  const metaItems = [];
  let subtotal = 0;
  let allFixedShipping = true;
  let fixedShippingTotal = 0;

  for (const [sku, quantity] of merged) {
    if (quantity > maxQty) throw new CheckoutError(`Max ${maxQty} per item for ${sku}`);
    const product = catalog.products.find((p) => (p.variants || []).some((v) => v.sku === sku));
    const variant = product?.variants.find((v) => v.sku === sku);
    if (!variant) throw new CheckoutError(`Unknown sku ${sku}`);
    if (variant.active === false) throw new CheckoutError(`${sku} is not available`);
    if (!isInt(variant.price_cents)) throw new CheckoutError(`Catalog price for ${sku} is not integer cents`, 500);

    const fulfiller = product.fulfiller || config.default_fulfiller || 'warehouse';
    const meta = {
      catalog_product_id: product.id,
      sku,
      fulfiller,
      ...(variant.printify_product_id || product.printify_product_id
        ? { printify_product_id: String(variant.printify_product_id || product.printify_product_id) } : {}),
      ...(variant.printify_variant_id ? { printify_variant_id: String(variant.printify_variant_id) } : {}),
    };
    if (fulfiller === 'printify' && (!meta.printify_product_id || !meta.printify_variant_id)) {
      throw new CheckoutError(`Catalog item ${sku} is set to Printify but has no printify ids`, 500);
    }

    lineItems.push({
      price_data: {
        currency,
        unit_amount: variant.price_cents,
        product_data: {
          name: variant.title && variant.title !== product.title ? `${product.title} - ${variant.title}` : product.title,
          ...(product.images?.[0] ? { images: [product.images[0]] } : {}),
          metadata: meta,
        },
      },
      quantity,
    });
    metaItems.push({ ...meta, quantity });
    subtotal += variant.price_cents * quantity;
    if (isInt(product.fixed_shipping_cents)) fixedShippingTotal += product.fixed_shipping_cents;
    else allFixedShipping = false;
  }

  const ship = config.shipping || {};
  let shippingOptions;
  if (allFixedShipping) {
    shippingOptions = [rate('Shipping & handling', fixedShippingTotal, currency, 3, 7)];
  } else {
    const free = isInt(ship.free_over_cents) && subtotal >= ship.free_over_cents;
    shippingOptions = (ship.options || []).slice(0, 5).map((o, i) =>
      rate(i === 0 && free ? (ship.free_label || o.label) : o.label, i === 0 && free ? 0 : o.amount_cents, currency, o.min_days, o.max_days));
  }

  // Session metadata (max 50 keys, 500 chars/value). One key per line so
  // fulfillment can map each item back to the catalog + Printify ids.
  const metadata = { store: 'fruity-puppy', item_count: String(metaItems.length) };
  metaItems.slice(0, 45).forEach((m, i) => {
    metadata[`item_${i}`] = JSON.stringify({
      sku: m.sku, pid: m.catalog_product_id, f: m.fulfiller, q: m.quantity,
      ...(m.printify_product_id ? { ppid: m.printify_product_id, pvid: m.printify_variant_id } : {}),
    });
  });

  const urls = checkoutUrls(config, env);
  const countries = ship.countries?.length ? ship.countries : ['US'];
  return {
    mode: 'payment',
    success_url: urls.success,
    cancel_url: urls.cancel,
    line_items: lineItems,
    metadata,
    payment_intent_data: { metadata: { store: 'fruity-puppy' } },
    shipping_address_collection: { allowed_countries: countries },
    shipping_options: shippingOptions,
    phone_number_collection: { enabled: true },
    allow_promotion_codes: config.checkout?.promo_codes ? true : undefined,
    automatic_tax: { enabled: Boolean(config.checkout?.automatic_tax) },
  };
}

function rate(label, amount, currency, minDays, maxDays) {
  if (!isInt(amount)) throw new CheckoutError(`Shipping amount for "${label}" must be integer cents`, 500);
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: label,
      fixed_amount: { amount, currency },
      ...(minDays && maxDays ? {
        delivery_estimate: {
          minimum: { unit: 'business_day', value: minDays },
          maximum: { unit: 'business_day', value: maxDays },
        },
      } : {}),
    },
  };
}

async function stripeRequest(method, path, { key, params, fetchImpl = fetch, idempotencyKey } = {}) {
  if (!key) throw new CheckoutError('STRIPE_SECRET_KEY is not set', 500);
  const res = await fetchImpl(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: params ? encodeStripeForm(params) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const e = data?.error || {};
    // Stripe error messages never contain the secret key; log type/code only.
    console.error(`[stripe] ${method} ${path} failed: ${res.status} ${e.type || ''} ${e.code || ''}`.trim());
    throw new CheckoutError(e.message || `Stripe request failed (${res.status})`, 502);
  }
  return data;
}

export function createCheckoutSession(params, opts) {
  return stripeRequest('POST', '/checkout/sessions', { ...opts, params });
}

export function retrieveCheckoutSession(id, opts) {
  return stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`, opts);
}

/** Decode the item_N metadata written by buildCheckoutSessionParams. */
export function itemsFromSessionMetadata(metadata = {}) {
  const items = [];
  for (let i = 0; metadata[`item_${i}`] !== undefined; i++) {
    const m = JSON.parse(metadata[`item_${i}`]);
    items.push({
      sku: m.sku,
      catalog_product_id: m.pid,
      fulfiller: m.f,
      quantity: m.q,
      printify_product_id: m.ppid,
      printify_variant_id: m.pvid,
    });
  }
  return items;
}
