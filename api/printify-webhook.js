import { recordTracking } from '../lib/orders.js';
import { rateLimit } from '../lib/rate.js';
import { verifyPrintifySignature } from '../lib/signatures.js';
import { PrintifyClient } from '../lib/printify.js';

// Printify posts order events here (order:shipment:created / order:shipment:delivered).
// Register the webhook with a secret (see store/OPERATOR.md); requests are verified
// against PRINTIFY_WEBHOOK_SECRET using the X-Pfy-Signature header and rejected otherwise.
//
// Event shape (Printify v1):
// { id, type: "order:shipment:created", resource: { id: <printify order id>, type: "order",
//   data: { shop_id, shipped_at, carrier: { code, tracking_number, tracking_url }, skus } } }

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export async function POST(request) {
  const limited = rateLimit(request, { limit: 30 });
  if (limited) return limited;

  const secret = process.env.PRINTIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[printify-webhook] PRINTIFY_WEBHOOK_SECRET is not set; rejecting');
    return reply({ error: 'Webhook not configured' }, 503);
  }
  const raw = await request.text();
  const check = verifyPrintifySignature(raw, request.headers.get('x-pfy-signature'), secret);
  if (!check.ok) return reply({ error: `Invalid signature: ${check.reason}` }, 401);

  let event;
  try { event = JSON.parse(raw); } catch { return reply({ error: 'Bad JSON' }, 400); }

  if (!['order:shipment:created', 'order:shipment:delivered'].includes(event.type)) {
    return reply({ ok: true, ignored: event.type || 'unknown' });
  }

  const printifyOrderId = event.resource?.id;
  const carrier = event.resource?.data?.carrier || {};
  if (!printifyOrderId || !carrier.tracking_number) return reply({ error: 'Missing order id or tracking number' }, 400);

  try {
    // Map back to our order id (the Stripe session id we sent as external_id).
    let ourOrderId = printifyOrderId;
    try {
      const order = await new PrintifyClient().getOrder(printifyOrderId);
      if (order?.external_id) ourOrderId = order.external_id;
    } catch (err) {
      console.error(`[printify-webhook] could not look up external_id for ${printifyOrderId}: ${err.message}`);
    }
    await recordTracking({ id: ourOrderId }, 'printify', {
      carrier: carrier.code || 'Printify',
      tracking_number: carrier.tracking_number,
      tracking_url: carrier.tracking_url,
      printify_order_id: printifyOrderId,
    });
    return reply({ ok: true });
  } catch (err) {
    console.error(`[printify-webhook] failed for ${printifyOrderId}: ${err.message}`);
    return reply({ error: 'Failed to record tracking' }, 500);
  }
}
