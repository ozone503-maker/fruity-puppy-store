// Order/tracking records.
//
// WARNING: this is an in-memory store. On Vercel each function instance has its
// own memory and it is wiped on cold start, so tracking recorded here is NOT
// durable. Wire this to a real store (Vercel KV/Upstash, Postgres, or a Stripe
// metadata update) before relying on it for customer-facing tracking.
const trackingStore = new Map();

export async function recordTracking(order, fulfiller, tracking) {
  if (!order?.id) throw new Error('recordTracking: order id is required');
  if (!tracking?.tracking_number) throw new Error(`recordTracking: tracking number missing for ${order.id}`);
  const record = {
    carrier: tracking.carrier || null,
    tracking_number: String(tracking.tracking_number),
    tracking_url: tracking.tracking_url || null,
    printify_order_id: tracking.printify_order_id || null,
    fulfiller,
    at: new Date().toISOString(),
  };
  trackingStore.set(String(order.id), record);
  // Log ids only; no customer PII.
  console.log(`[orders] tracking recorded for ${order.id} via ${fulfiller} (${record.carrier || 'carrier?'})`);
  return record;
}

export function getTracking(orderId) {
  return trackingStore.get(String(orderId));
}
