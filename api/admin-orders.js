import { json, requireBearer } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';

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
