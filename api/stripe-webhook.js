import { loadStore } from '../lib/store.js';
import { verifyStripeSignature } from '../lib/signatures.js';
import { itemsFromSessionMetadata } from '../lib/stripe.js';
import { fulfillOrder } from '../lib/fulfillment.js';

// Stripe webhook: on a paid Checkout Session, route each item to its fulfiller.
// Configure in Stripe Dashboard > Developers > Webhooks:
//   URL: https://<site>/api/stripe-webhook
//   Events: checkout.session.completed, checkout.session.async_payment_succeeded
// Requires STRIPE_WEBHOOK_SECRET (whsec_...). Unsigned/invalid requests are rejected.

const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

export async function POST(request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set; rejecting');
    return text('Webhook not configured', 503);
  }
  const raw = await request.text(); // must be the raw body for signature verification
  const check = verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret);
  if (!check.ok) return text(`Invalid signature: ${check.reason}`, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return text('Bad JSON', 400); }

  const handled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!handled.includes(event.type)) return text('ignored', 200);

  const session = event.data?.object || {};
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return text('not paid yet', 200); // async payments arrive later as async_payment_succeeded
  }

  try {
    const results = await fulfillSession(session);
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    // 500 makes Stripe retry. Log ids only, no PII.
    console.error(`[stripe-webhook] fulfillment failed for ${session.id}: ${err.message}`);
    return text('Fulfillment failed', 500);
  }
}

export async function fulfillSession(session, { store = loadStore(), fulfill = fulfillOrder } = {}) {
  const { catalog, config } = store;
  const items = itemsFromSessionMetadata(session.metadata || {});
  if (!items.length) throw new Error(`Session ${session.id} has no item metadata`);

  const shipping = session.collected_information?.shipping_details || session.shipping_details || {};
  const addr = shipping.address || {};
  const baseOrder = {
    id: session.id,
    email: session.customer_details?.email || session.customer_email,
    shipping: {
      name: shipping.name || session.customer_details?.name,
      phone: session.customer_details?.phone || '',
      line1: addr.line1, line2: addr.line2, city: addr.city,
      state: addr.state, postal_code: addr.postal_code, country: addr.country,
    },
  };

  // Group by fulfiller, re-checking each SKU against the current catalog.
  const groups = new Map();
  for (const it of items) {
    const product = catalog.products.find((p) => p.id === it.catalog_product_id)
      || catalog.products.find((p) => (p.variants || []).some((v) => v.sku === it.sku));
    const variant = product?.variants?.find((v) => v.sku === it.sku);
    if (!variant) throw new Error(`Session ${session.id}: sku ${it.sku} not in catalog`);
    const fulfillerName = it.fulfiller || product.fulfiller || config.default_fulfiller || 'warehouse';
    const item = {
      sku: it.sku,
      quantity: it.quantity,
      printify_product_id: it.printify_product_id || variant.printify_product_id || product.printify_product_id,
      printify_variant_id: it.printify_variant_id || variant.printify_variant_id,
    };
    if (!groups.has(fulfillerName)) groups.set(fulfillerName, []);
    groups.get(fulfillerName).push(item);
  }

  const results = {};
  for (const [name, groupItems] of groups) {
    const fcfg = config.fulfillers?.[name];
    if (!fcfg) throw new Error(`No fulfiller "${name}" in store/config.json`);
    results[name] = await fulfill({ ...baseOrder, items: groupItems }, fcfg);
  }
  return results;
}
