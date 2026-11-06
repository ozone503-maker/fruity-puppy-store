import { getOrderStore } from './order-store.js';
import { loadStore } from './store.js';
import { stripeGet } from './stripe.js';
import { queueConfirmation, dispatchConfirmation } from './email.js';

// Payment state and fulfillment state are tracked separately.
// payment: pending | paid | failed | expired
// fulfillment: not_ready | queued | handoff_pending | shipped | cancelled
// Nothing here sends to Printify or emails anyone; the queue is read through the admin endpoint.

function findVariant(catalog, sku) {
  for (const p of catalog.products) {
    const v = p.variants.find(x => x.sku === sku);
    if (v) return { product: p, variant: v };
  }
  return null;
}

// Builds order lines from Stripe's own record of the session (server-trusted),
// matched back to the catalog by SKU stored in metadata at checkout.
export async function buildOrderFromSession(session, { stripeKey, fetchImpl } = {}) {
  const brand = session.metadata?.brand || undefined;
  const { config, catalog } = loadStore(brand);
  const li = await stripeGet(
    `/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100&expand[]=data.price.product`,
    stripeKey, fetchImpl,
  );
  const items = li.data.map(line => {
    const sku = line.price?.metadata?.sku || line.price?.product?.metadata?.sku || null;
    const match = sku ? findVariant(catalog, sku) : null;
    const fulfiller = match?.product.fulfiller || config.default_fulfiller || 'warehouse';
    return {
      sku,
      title: line.description,
      quantity: line.quantity,
      amount_total_cents: line.amount_total,
      fulfiller,
      fulfiller_adapter: config.fulfillers?.[fulfiller]?.adapter || 'manual',
      printify_product_id: match?.variant.printify_product_id || null,
      printify_variant_id: match?.variant.printify_variant_id || null,
      unmatched: !match,
    };
  });
  const details = session.customer_details || {};
  const ship = session.shipping_details || session.collected_information?.shipping_details || {};
  return {
    id: session.id,
    brand: brand || 'default',
    livemode: !!session.livemode,
    created_at_ms: (session.created || Math.floor(Date.now() / 1000)) * 1000,
    currency: session.currency,
    amount_total_cents: session.amount_total,
    amount_shipping_cents: session.total_details?.amount_shipping ?? null,
    payment_intent: session.payment_intent || null,
    email: details.email || null,
    shipping: { name: ship.name || details.name || null, address: ship.address || details.address || null },
    items,
    payment: 'pending',
    fulfillment: 'not_ready',
    history: [],
  };
}

const PAYMENT_FOR_EVENT = {
  'checkout.session.completed': s => (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') ? 'paid' : 'pending',
  'checkout.session.async_payment_succeeded': () => 'paid',
  'checkout.session.async_payment_failed': () => 'failed',
  'checkout.session.expired': () => 'expired',
};
export const HANDLED_EVENTS = Object.keys(PAYMENT_FOR_EVENT);

function nextFulfillment(order) {
  if (order.payment === 'paid') {
    if (order.fulfillment !== 'not_ready') return order.fulfillment;
    return order.items.some(i => i.fulfiller_adapter === 'printify') ? 'handoff_pending' : 'queued';
  }
  if (order.payment === 'failed' || order.payment === 'expired') return order.fulfillment === 'not_ready' ? 'cancelled' : order.fulfillment;
  return order.fulfillment;
}

// Idempotent: replays of an event id are ignored; out-of-order events never downgrade paid.
export async function applyCheckoutEvent(event, { store = getOrderStore(), stripeKey = process.env.STRIPE_SECRET_KEY, fetchImpl, emailFetch } = {}) {
  if (!store) { const e = new Error('Order store not configured'); e.status = 503; throw e; }
  const map = PAYMENT_FOR_EVENT[event.type];
  if (!map) return { ignored: true };
  if (!(await store.claimEvent(event.id))) return { duplicate: true };
  try {
    const session = event.data.object;
    let order = await store.getOrder(session.id);
    if (!order) {
      if (event.type === 'checkout.session.expired') {
        await store.releaseEvent(event.id);
        return { ignored: true, reason: 'expired_without_order' };
      }
      order = await buildOrderFromSession(session, { stripeKey, fetchImpl });
    }
    const target = map(session);
    if (!(order.payment === 'paid' && target !== 'paid')) order.payment = target;
    order.fulfillment = nextFulfillment(order);
    order.history.push({ event: event.type, event_id: event.id, at: new Date().toISOString() });
    const queued = queueConfirmation(order);
    await store.putOrder(order);
    // Order is durably recorded first; email problems never fail the webhook.
    if (queued) await dispatchConfirmation(order, store, { fetchImpl: emailFetch }).catch(() => {});
    return { order_id: order.id, payment: order.payment, fulfillment: order.fulfillment };
  } catch (err) {
    await store.releaseEvent(event.id).catch(() => {});
    throw err;
  }
}

export async function recordTracking(orderId, fulfiller, tracking, { store = getOrderStore() } = {}) {
  if (!store) { const e = new Error('Order store not configured'); e.status = 503; throw e; }
  const order = await store.getOrder(orderId);
  if (!order) return null;
  order.tracking = { ...tracking, fulfiller, at: new Date().toISOString() };
  if (order.payment === 'paid') order.fulfillment = 'shipped';
  order.history.push({ event: 'tracking', at: order.tracking.at });
  await store.putOrder(order);
  return order.tracking;
}
