import { createHmac, timingSafeEqual } from 'node:crypto';
import { recordTracking } from '../lib/orders.js';
import { json } from '../lib/http.js';

// Printify shipment updates. Requires PRINTIFY_WEBHOOK_SECRET (the secret set when the
// webhook is registered); Printify signs with X-Pfy-Signature: sha256=<hex HMAC of body>.
// Fails closed when the secret is not configured.
export function verifyPrintify(raw, header, secret) {
  if (!secret || !header) return false;
  const given = Buffer.from(header.replace(/^sha256=/, ''));
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request, deps = {}) {
  const secret = process.env.PRINTIFY_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'Not configured' }, 503);
  const raw = await request.text();
  if (!verifyPrintify(raw, request.headers.get('x-pfy-signature'), secret)) return json({ error: 'Invalid signature' }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }
  const event = body.resource?.data || body.resource || body;
  const orderId = event.external_id || event.order_external_id;
  const shipment = (event.shipments || [])[0] || {};
  const tracking = shipment.tracking_number || shipment.number || event.tracking_number;
  if (!orderId || !tracking) return json({ ok: true, ignored: true });

  try {
    const saved = await recordTracking(orderId, 'printify', {
      carrier: shipment.carrier || event.carrier || 'Printify',
      tracking_number: tracking,
      tracking_url: shipment.tracking_url || shipment.url || event.tracking_url || null,
    }, deps.store !== undefined ? { store: deps.store } : {});
    return json({ ok: true, matched: !!saved });
  } catch (err) {
    return json({ error: 'Temporary failure' }, err.status || 500);
  }
}
