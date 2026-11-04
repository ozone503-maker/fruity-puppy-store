import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeStripeForm, buildCheckoutSessionParams, itemsFromSessionMetadata, createCheckoutSession, CheckoutError } from '../lib/stripe.js';
import { verifyStripeSignature, signStripePayload } from '../lib/signatures.js';

const env = { STORE_SITE_URL: 'https://brobots.space' };
const config = {
  currency: 'usd', cart: { max_qty_per_item: 20 }, checkout: { promo_codes: true, automatic_tax: false },
  shipping: { countries: ['US'], options: [{ label: 'Standard', amount_cents: 800, min_days: 3, max_days: 7 }, { label: 'Express', amount_cents: 2200, min_days: 1, max_days: 3 }], free_over_cents: 7500, free_label: 'Free standard shipping' },
  default_fulfiller: 'warehouse',
};
const catalog = { products: [
  { id: 'fruity-puppy-original', title: 'Fruity Puppy Original', fulfiller: 'warehouse', variants: [{ sku: 'FP-2OZ', title: '2 oz', price_cents: 5999 }] },
  { id: 'free-sample', title: 'Free Sample', fulfiller: 'warehouse', fixed_shipping_cents: 500, variants: [{ sku: 'FP-SAMPLE', title: 'Sample', price_cents: 0 }] },
  { id: 'tee', title: 'Tee', fulfiller: 'printify', printify_product_id: 'abc123', images: ['https://images.printify.com/x.png'],
    variants: [{ sku: 'TEE-17428', title: 'Black / M', price_cents: 1299, printify_product_id: 'abc123', printify_variant_id: 17428 }] },
] };

test('encodeStripeForm encodes nested objects and arrays', () => {
  const s = encodeStripeForm({ a: 1, line_items: [{ price_data: { unit_amount: 100, product_data: { name: 'A & B' } }, quantity: 2 }], meta: { x: 'y' }, b: true, skip: undefined });
  const p = new URLSearchParams(s);
  assert.equal(p.get('a'), '1');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '100');
  assert.equal(p.get('line_items[0][price_data][product_data][name]'), 'A & B');
  assert.equal(p.get('line_items[0][quantity]'), '2');
  assert.equal(p.get('meta[x]'), 'y');
  assert.equal(p.get('b'), 'true');
  assert.equal(p.has('skip'), false);
});

test('checkout params use catalog cents, env URLs, and carry ids in metadata', () => {
  const params = buildCheckoutSessionParams({ items: [{ sku: 'TEE-17428', quantity: 2 }, { sku: 'FP-2OZ' }], catalog, config, env });
  const p = new URLSearchParams(encodeStripeForm(params));
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('success_url'), 'https://brobots.space/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.get('cancel_url'), 'https://brobots.space/?checkout=cancel');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '1299');
  assert.equal(p.get('line_items[0][quantity]'), '2');
  assert.equal(p.get('line_items[0][price_data][product_data][metadata][printify_variant_id]'), '17428');
  assert.equal(p.get('line_items[1][price_data][unit_amount]'), '5999');
  assert.equal(p.get('shipping_address_collection[allowed_countries][0]'), 'US');
  // subtotal 2*1299+5999 = 8597 >= 7500 -> free standard
  assert.equal(p.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '0');
  assert.equal(p.get('allow_promotion_codes'), 'true');
  const items = itemsFromSessionMetadata(params.metadata);
  assert.deepEqual(items[0], { sku: 'TEE-17428', catalog_product_id: 'tee', fulfiller: 'printify', quantity: 2, printify_product_id: 'abc123', printify_variant_id: '17428' });
  for (const v of Object.values(params.metadata)) assert.ok(v.length <= 500);
});

test('free sample alone gets its fixed shipping', () => {
  const params = buildCheckoutSessionParams({ items: [{ sku: 'FP-SAMPLE' }], catalog, config, env });
  assert.equal(params.shipping_options.length, 1);
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 500);
});

test('checkout rejects bad input and ignores client URLs', () => {
  assert.throws(() => buildCheckoutSessionParams({ items: [], catalog, config, env }), CheckoutError);
  assert.throws(() => buildCheckoutSessionParams({ items: [{ sku: 'NOPE' }], catalog, config, env }), /Unknown sku/);
  assert.throws(() => buildCheckoutSessionParams({ items: [{ sku: 'FP-2OZ', quantity: -1 }], catalog, config, env }), /Invalid quantity/);
  assert.throws(() => buildCheckoutSessionParams({ items: [{ sku: 'FP-2OZ', quantity: 1.5 }], catalog, config, env }), /Invalid quantity/);
  assert.throws(() => buildCheckoutSessionParams({ items: [{ sku: 'FP-2OZ', quantity: 21 }], catalog, config, env }), /Max 20/);
  assert.throws(() => buildCheckoutSessionParams({ items: [{ sku: 'FP-2OZ' }], catalog, config, env: {} }), /STORE_SITE_URL/);
  const params = buildCheckoutSessionParams({ items: [{ sku: 'FP-2OZ', success_url: 'https://evil.example' }], catalog, config, env });
  assert.equal(params.success_url.startsWith('https://brobots.space'), true);
});

test('createCheckoutSession posts form-encoded body with bearer key and surfaces Stripe errors', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }), { status: 200 }); };
  const s = await createCheckoutSession({ mode: 'payment', line_items: [{ quantity: 1 }] }, { key: 'sk_test_x', fetchImpl: ok });
  assert.equal(s.id, 'cs_test_1');
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk_test_x');
  assert.match(seen.init.body, /line_items%5B0%5D%5Bquantity%5D=1/);
  const bad = async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad param' } }), { status: 400 });
  await assert.rejects(createCheckoutSession({}, { key: 'sk_test_x', fetchImpl: bad }), /bad param/);
});

test('Stripe webhook signature verification', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const header = signStripePayload(body, 'whsec_test');
  assert.equal(verifyStripeSignature(body, header, 'whsec_test').ok, true);
  assert.equal(verifyStripeSignature(body + ' ', header, 'whsec_test').ok, false);
  assert.equal(verifyStripeSignature(body, header, 'whsec_other').ok, false);
  assert.equal(verifyStripeSignature(body, header, '').ok, false);
  const old = signStripePayload(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyStripeSignature(body, old, 'whsec_test').reason, 'timestamp outside tolerance');
});
