import { json } from '../lib/http.js';
import { getOrderStore } from '../lib/order-store.js';

// Public, minimal: given the unguessable Checkout Session id from the redirect,
// returns only payment/fulfillment state. No email, address, or line items.
export async function GET(request, deps = {}) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json({ status: 'unknown' }, 400);
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!store) return json({ status: 'unknown' });
  try {
    const order = await store.getOrder(id);
    if (!order) return json({ status: 'processing' });
    return json({ status: order.payment, fulfillment: order.fulfillment });
  } catch {
    return json({ status: 'unknown' });
  }
}
