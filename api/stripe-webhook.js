import { json } from '../lib/http.js';
import { verifyStripeSignature } from '../lib/stripe.js';
import { applyCheckoutEvent } from '../lib/orders.js';
import { getOrderStore } from '../lib/order-store.js';

// Stripe → order record. Fails closed (503, Stripe retries for up to 3 days)
// when the signing secret or the order store is not configured.
export async function POST(request, deps = {}) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const store = deps.store !== undefined ? deps.store : getOrderStore();
  if (!secret || !store) return json({ error: 'Not configured' }, 503);

  const raw = await request.text();
  if (!verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret)) {
    return json({ error: 'Invalid signature' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }

  try {
    const result = await applyCheckoutEvent(event, { store, fetchImpl: deps.fetchImpl });
    return json({ received: true, ...('duplicate' in result ? { duplicate: true } : {}) });
  } catch (err) {
    console.error('stripe-webhook failed', event.type, err.message);
    return json({ error: 'Temporary failure' }, err.status || 500);
  }
}
