import { recordTracking } from '../lib/orders.js';
import { rateLimit } from '../lib/rate.js';

// Printify posts shipment updates here. Set the webhook URL in the Printify dashboard.
export async function POST(request) {
  const limited = rateLimit(request, { limit: 30 });
  if (limited) return limited;

  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const event = body.resource || body;
  const orderId = event.external_id || event.order_external_id;
  const shipment = (event.shipments || [])[0] || {};
  const tracking = shipment.tracking_number || event.tracking_number;
  const carrier = shipment.carrier || event.carrier || 'Printify';
  const url = shipment.tracking_url || event.tracking_url;

  if (!orderId || !tracking) return new Response('Missing order or tracking', { status: 400 });

  try {
    await recordTracking({ id: orderId }, 'printify', { carrier, tracking_number: tracking, tracking_url: url });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
