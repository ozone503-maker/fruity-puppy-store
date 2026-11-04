import { loadStore } from '../lib/store.js';
import { json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { buildCheckoutSessionParams, createCheckoutSession, CheckoutError } from '../lib/stripe.js';

// Creates a Stripe Checkout Session from server-side catalog prices.
// Body: { items: [{ sku, quantity }] }
// success/cancel URLs come from env (STORE_SITE_URL or STORE_SUCCESS_URL/STORE_CANCEL_URL),
// never from the request body, so the endpoint can't be used as an open redirect.
export async function POST(request) {
  const limited = rateLimit(request, { limit: 20 });
  if (limited) return limited;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[checkout] STRIPE_SECRET_KEY is not set');
    return json({ error: 'Checkout is not configured' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  try {
    const { catalog, config } = loadStore();
    const params = buildCheckoutSessionParams({ items: body?.items, catalog, config });
    const session = await createCheckoutSession(params, { key: stripeKey });
    if (!session?.url) throw new CheckoutError('Stripe did not return a checkout URL', 502);
    return json({ url: session.url, id: session.id });
  } catch (err) {
    if (err instanceof CheckoutError) {
      if (err.status >= 500) console.error(`[checkout] ${err.message}`);
      // Don't echo internal config errors to shoppers.
      return json({ error: err.status >= 500 ? 'Checkout is temporarily unavailable' : err.message }, err.status);
    }
    console.error('[checkout] unexpected error:', err?.message);
    return json({ error: 'Checkout failed' }, 500);
  }
}
