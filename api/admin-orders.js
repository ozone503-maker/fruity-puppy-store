import { json, requireBearer } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';
import { dispatchConfirmation, emailConfig, canSend } from '../lib/email.js';

// Fulfillment queue for the operator. Requires Authorization: Bearer $ADMIN_TOKEN.
export async function GET(request, deps = {}) {
  const denied = requireBearer(request, 'ADMIN_TOKEN');
  if (denied) return denied;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ error: 'Order store not configured' }, 503);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  const want = url.searchParams.get('fulfillment');
  const ids = await store.listOrderIds(limit);
  const orders = [];
  for (const id of ids) {
    const o = await store.getOrder(id);
    if (o && (!want || o.fulfillment === want)) orders.push(o);
  }
  return json({ orders });
}

// Retry queued/failed confirmation emails. No-op while sending is disabled.
export async function POST(request, deps = {}) {
  const denied = requireBearer(request, 'ADMIN_TOKEN');
  if (denied) return denied;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ error: 'Order store not configured' }, 503);
  const cfg = deps.cfg || emailConfig();
  if (!canSend(cfg)) return json({ sending: 'disabled', attempted: 0 });
  const ids = await store.listOrderIds(200);
  const results = [];
  for (const id of ids) {
    const o = await store.getOrder(id);
    const st = o?.confirmation_email?.status;
    if (st === 'pending' || (st === 'failed' && o.confirmation_email.attempts < 5)) {
      results.push({ id, ...(await dispatchConfirmation(o, store, { cfg, fetchImpl: deps.fetchImpl })) });
    }
  }
  return json({ sending: 'enabled', attempted: results.length, results });
}
