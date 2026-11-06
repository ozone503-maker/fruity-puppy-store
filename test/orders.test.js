import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST as checkout, redirectUrls } from '../api/checkout.js';
import { POST as webhook } from '../api/stripe-webhook.js';
import { GET as status } from '../api/order-status.js';
import { GET as adminOrders } from '../api/admin-orders.js';
import { POST as stripeSync } from '../api/stripe-sync.js';
import { POST as printifyHook } from '../api/printify-webhook.js';
import { GET as catalog } from '../api/catalog.js';
import { memoryStore, upstashStore } from '../lib/order-store.js';
import { verifyStripeSignature } from '../lib/stripe.js';

const WH = 'whsec_test_local_only';
const SID = 'cs_test_a1B2c3D4e5F6g7H8i9J0';
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_only';
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.ADMIN_TOKEN = 'admin-local-token';
  process.env.PRINTIFY_WEBHOOK_SECRET = 'pfy-local';
});

const post = (url, body, headers = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function signed(event, secret = WH, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return post('https://x/api/stripe-webhook', raw, { 'stripe-signature': `t=${t},v1=${sig}` });
}
function stripeMock(captured) {
  return async (url, init) => {
    captured?.push({ url, init });
    if (url.includes('/line_items')) return new Response(JSON.stringify({ data: [
      { description: 'Fruity Puppy Original - 2 oz', quantity: 2, amount_total: 11998, price: { product: { metadata: { sku: 'FP-2OZ' } }, metadata: {} } },
      { description: 'Tee - White', quantity: 1, amount_total: 2800, price: { product: { metadata: { sku: 'FP-TEE-WHITE' } }, metadata: {} } },
    ] }), { status: 200 });
    return new Response(JSON.stringify({ id: SID, url: 'https://checkout.stripe.com/c/pay/x' }), { status: 200 });
  };
}
const session = (extra = {}) => ({ id: SID, object: 'checkout.session', payment_status: 'paid', amount_total: 14798, currency: 'usd', created: 1790000000, metadata: { brand: '' }, customer_details: { email: 'a@example.com' }, ...extra });
const evt = (id, type, s = session()) => ({ id, type, data: { object: s } });

// ---------- checkout ----------
test('checkout ignores malicious redirects and uses allowed origin', async () => {
  const cap = [];
  const res = await checkout(post('https://x/api/checkout', { items: [{ sku: 'FP-2OZ', quantity: 2 }], success_url: 'https://evil.example/store/confirmation', cancel_url: 'https://evil.example' }), { fetchImpl: stripeMock(cap) });
  assert.equal(res.status, 200);
  const p = new URLSearchParams(cap[0].init.body);
  assert.equal(p.get('success_url'), 'https://brobots.space/store/confirmation?session_id={CHECKOUT_SESSION_ID}'.replace('https://brobots.space', JSON.parse((await import('node:fs')).readFileSync(new URL('../store/config.json', import.meta.url))).allowed_origins[0]));
  assert.ok(!p.toString().includes('evil'));
  assert.equal(p.get('line_items[0][price_data][product_data][metadata][sku]'), 'FP-2OZ');
  assert.equal(p.get('line_items[0][quantity]'), '2');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '5999');
});
test('redirect keeps allowed origin and mount', () => {
  const cfg = { allowed_origins: ['https://fruitypuppy.com', 'https://www.fruitypuppy.com'] };
  assert.equal(redirectUrls(cfg, undefined, 'https://www.fruitypuppy.com/store/confirmation?x').success_url, 'https://www.fruitypuppy.com/store/confirmation?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(redirectUrls(cfg, 'brobots', 'javascript:alert(1)').cancel_url, 'https://fruitypuppy.com/store/cart?brand=brobots');
});
for (const [name, items, msg] of [
  ['bad sku', [{ sku: 'NOPE', quantity: 1 }], 'no longer available'],
  ['zero qty', [{ sku: 'FP-2OZ', quantity: 0 }], 'Invalid quantity'],
  ['fractional qty', [{ sku: 'FP-2OZ', quantity: 1.5 }], 'Invalid quantity'],
  ['string qty', [{ sku: 'FP-2OZ', quantity: '3' }], 'Invalid quantity'],
  ['over max', [{ sku: 'FP-2OZ', quantity: 21 }], 'Maximum 20'],
  ['over max merged', [{ sku: 'FP-2OZ', quantity: 15 }, { sku: 'FP-2OZ', quantity: 6 }], 'Maximum 20'],
  ['empty', [], 'empty'],
]) test(`checkout rejects ${name} with 400`, async () => {
  const cap = [];
  const res = await checkout(post('https://x/api/checkout', { items }), { fetchImpl: stripeMock(cap) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, new RegExp(msg));
  assert.equal(cap.length, 0);
});
test('checkout bad json and missing key', async () => {
  assert.equal((await checkout(post('https://x/api/checkout', '{'))).status, 400);
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await checkout(post('https://x/api/checkout', { items: [{ sku: 'FP-2OZ' }] }))).status, 503);
});
test('checkout stripe error does not leak details', async () => {
  const res = await checkout(post('https://x/api/checkout', { items: [{ sku: 'FP-2OZ' }] }), { fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'sk_test secret detail' } }), { status: 400 }) });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('secret'));
});

// ---------- webhook ----------
test('webhook rejects bad/missing/stale signatures', async () => {
  const store = memoryStore();
  assert.equal((await webhook(signed(evt('evt_1', 'checkout.session.completed'), 'wrong'), { store })).status, 400);
  assert.equal((await webhook(post('https://x', '{}'), { store })).status, 400);
  assert.equal((await webhook(signed(evt('evt_1', 'checkout.session.completed'), WH, Math.floor(Date.now() / 1000) - 3600), { store })).status, 400);
  assert.equal((await store.listOrderIds()).length, 0);
});
test('webhook fails closed without secret or store', async () => {
  assert.equal((await webhook(signed(evt('e', 'checkout.session.completed')), { store: null })).status, 503);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal((await webhook(signed(evt('e', 'checkout.session.completed')), { store: memoryStore() })).status, 503);
});
test('paid order persisted from Stripe line items; duplicate ignored', async () => {
  const store = memoryStore();
  const r = await webhook(signed(evt('evt_paid', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  assert.equal(r.status, 200);
  const o = await store.getOrder(SID);
  assert.equal(o.payment, 'paid');
  assert.equal(o.fulfillment, 'handoff_pending'); // tee is printify; nothing submitted
  assert.deepEqual(o.items.map(i => [i.sku, i.quantity, i.fulfiller_adapter]), [['FP-2OZ', 2, 'manual'], ['FP-TEE-WHITE', 1, 'printify']]);
  const dup = await webhook(signed(evt('evt_paid', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  assert.equal((await dup.json()).duplicate, true);
  assert.equal((await store.getOrder(SID)).history.length, 1);
  assert.equal((await store.listOrderIds()).length, 1);
});
test('async payment: pending then succeeded; failure path; no downgrade', async () => {
  const store = memoryStore(); const f = stripeMock();
  await webhook(signed(evt('e1', 'checkout.session.completed', session({ payment_status: 'unpaid' }))), { store, fetchImpl: f });
  let o = await store.getOrder(SID); assert.equal(o.payment, 'pending'); assert.equal(o.fulfillment, 'not_ready');
  await webhook(signed(evt('e2', 'checkout.session.async_payment_succeeded')), { store, fetchImpl: f });
  o = await store.getOrder(SID); assert.equal(o.payment, 'paid');
  await webhook(signed(evt('e3', 'checkout.session.async_payment_failed')), { store, fetchImpl: f });
  assert.equal((await store.getOrder(SID)).payment, 'paid');
  const s2 = memoryStore();
  await webhook(signed(evt('f1', 'checkout.session.completed', session({ payment_status: 'unpaid' }))), { store: s2, fetchImpl: f });
  await webhook(signed(evt('f2', 'checkout.session.async_payment_failed')), { store: s2, fetchImpl: f });
  o = await s2.getOrder(SID); assert.equal(o.payment, 'failed'); assert.equal(o.fulfillment, 'cancelled');
});
test('expired without order is ignored; unknown events ignored', async () => {
  const store = memoryStore();
  assert.equal((await webhook(signed(evt('x1', 'checkout.session.expired')), { store })).status, 200);
  assert.equal((await webhook(signed(evt('x2', 'charge.refunded')), { store })).status, 200);
  assert.equal((await store.listOrderIds()).length, 0);
});
test('persistence or Stripe failure returns 5xx and releases event for retry', async () => {
  const store = memoryStore(); const put = store.putOrder; let fail = true;
  store.putOrder = async o => { if (fail) throw new Error('down'); return put(o); };
  const r1 = await webhook(signed(evt('p1', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  assert.equal(r1.status, 500);
  fail = false;
  const r2 = await webhook(signed(evt('p1', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  assert.equal(r2.status, 200);
  assert.equal((await store.getOrder(SID)).payment, 'paid');
  const s2 = memoryStore();
  const r3 = await webhook(signed(evt('p2', 'checkout.session.completed')), { store: s2, fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(r3.status, 500);
  assert.equal(await s2.claimEvent('p2'), true);
});

// ---------- status / admin / sync / printify ----------
test('order-status returns only state, no PII', async () => {
  const store = memoryStore();
  await webhook(signed(evt('s1', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  const body = await (await status(new Request(`https://x/api/order-status?session_id=${SID}`), { store })).json();
  assert.deepEqual(body, { status: 'paid', fulfillment: 'handoff_pending' });
  assert.equal((await status(new Request('https://x/api/order-status?session_id=../../x'), { store })).status, 400);
  assert.equal((await (await status(new Request('https://x/api/order-status?session_id=cs_test_zzzzzzzzzzzzzz'), { store })).json()).status, 'processing');
});
test('admin orders requires bearer; fails closed when unset', async () => {
  const store = memoryStore();
  await webhook(signed(evt('a1', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  assert.equal((await adminOrders(new Request('https://x/api/admin-orders'), { store })).status, 401);
  assert.equal((await adminOrders(new Request('https://x/api/admin-orders', { headers: { authorization: 'Bearer wrong' } }), { store })).status, 401);
  const ok = await adminOrders(new Request('https://x/api/admin-orders?fulfillment=handoff_pending', { headers: { authorization: 'Bearer admin-local-token' } }), { store });
  assert.equal((await ok.json()).orders.length, 1);
  delete process.env.ADMIN_TOKEN;
  assert.equal((await adminOrders(new Request('https://x/api/admin-orders', { headers: { authorization: 'Bearer ' } }), { store })).status, 503);
});
test('stripe-sync is locked without admin token', async () => {
  assert.equal((await stripeSync(new Request('https://x/api/stripe-sync', { method: 'POST' }))).status, 401);
  delete process.env.ADMIN_TOKEN;
  assert.equal((await stripeSync(new Request('https://x/api/stripe-sync', { method: 'POST' }))).status, 503);
});
test('printify webhook requires valid signature and records tracking', async () => {
  const store = memoryStore();
  await webhook(signed(evt('t1', 'checkout.session.completed')), { store, fetchImpl: stripeMock() });
  const raw = JSON.stringify({ resource: { data: { external_id: SID, shipments: [{ carrier: 'usps', number: '9400', url: 'https://t' }] } } });
  const sig = 'sha256=' + createHmac('sha256', 'pfy-local').update(raw).digest('hex');
  assert.equal((await printifyHook(post('https://x', raw, { 'x-pfy-signature': 'sha256=bad' }), { store })).status, 401);
  const r = await printifyHook(post('https://x', raw, { 'x-pfy-signature': sig }), { store });
  assert.equal((await r.json()).matched, true);
  assert.equal((await store.getOrder(SID)).fulfillment, 'shipped');
  delete process.env.PRINTIFY_WEBHOOK_SECRET;
  assert.equal((await printifyHook(post('https://x', raw, { 'x-pfy-signature': sig }), { store })).status, 503);
});

// ---------- adapter + regressions ----------
test('upstash adapter speaks REST commands and surfaces errors', async () => {
  const calls = [];
  const s = upstashStore({ url: 'https://kv.example', token: 't', fetchImpl: async (u, i) => { const a = JSON.parse(i.body); calls.push(a); return new Response(JSON.stringify({ result: a[0] === 'SET' ? 'OK' : a[0] === 'GET' ? '{"id":"o"}' : [] })); } });
  assert.equal(await s.claimEvent('e'), true);
  assert.deepEqual(calls[0].slice(0, 4), ['SET', 'fps:evt:e', '1', 'NX']);
  assert.deepEqual(await s.getOrder('o'), { id: 'o' });
  const bad = upstashStore({ url: 'https://kv.example', token: 't', fetchImpl: async () => new Response('{"error":"x"}', { status: 401 }) });
  await assert.rejects(bad.getOrder('o'));
});
test('signature helper', () => {
  const t = 1000; const raw = '{}';
  const v = createHmac('sha256', 's').update(`${t}.${raw}`).digest('hex');
  assert.ok(verifyStripeSignature(raw, `t=${t},v1=${v}`, 's', { now: t * 1000 }));
  assert.ok(!verifyStripeSignature(raw + ' ', `t=${t},v1=${v}`, 's', { now: t * 1000 }));
});
test('catalog unchanged shape', async () => {
  const d = await (await catalog(new Request('https://x/api/catalog'))).json();
  assert.equal(d.products.length, 13);
  assert.ok(d.products.every(p => p.variants.every(v => 'sku' in v && 'price_cents' in v)));
});
