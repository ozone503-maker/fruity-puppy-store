import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfillOrder, toPrintifyAddress } from '../lib/fulfillment.js';
import { fulfillSession } from '../api/stripe-webhook.js';
import { POST as printifyWebhook } from '../api/printify-webhook.js';
import { POST as stripeWebhook } from '../api/stripe-webhook.js';
import { signPrintifyPayload } from '../lib/signatures.js';

const cfg = { adapter: 'printify', token_env: 'PRINTIFY_API_TOKEN', shop_id_env: 'PRINTIFY_SHOP_ID', send_to_production: false };
const goodOrder = {
  id: 'cs_test_1', email: 'a@example.com',
  shipping: { name: 'Ada Lovelace', line1: '1 Main St', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' },
  items: [{ sku: 'TEE-17428', quantity: 1, printify_product_id: 'abc123', printify_variant_id: '17428' }],
};

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

test('printify adapter fails loudly on missing ids, env, or address', async () => {
  await withEnv({ PRINTIFY_API_TOKEN: 't', PRINTIFY_SHOP_ID: '1', PRINTIFY_TOKEN: undefined }, async () => {
    const client = { createOrder: async () => { throw new Error('should not be called'); } };
    await assert.rejects(fulfillOrder({ ...goodOrder, items: [{ sku: 'X', quantity: 1, printify_variant_id: 1 }] }, cfg, { client }), /missing printify_product_id/);
    await assert.rejects(fulfillOrder({ ...goodOrder, items: [{ sku: 'X', quantity: 1, printify_product_id: 'p' }] }, cfg, { client }), /printify_variant_id/);
    await assert.rejects(fulfillOrder({ ...goodOrder, items: [] }, cfg, { client }), /no items/);
    await assert.rejects(fulfillOrder({ ...goodOrder, shipping: { ...goodOrder.shipping, line1: '' } }, cfg, { client }), /address line 1/);
    await assert.rejects(fulfillOrder({ ...goodOrder, shipping: { ...goodOrder.shipping, state: '' } }, cfg, { client }), /region/);
    await assert.rejects(fulfillOrder({ ...goodOrder, email: '' }, cfg, { client }), /email/);
  });
  await withEnv({ PRINTIFY_API_TOKEN: undefined, PRINTIFY_TOKEN: undefined, PRINTIFY_SHOP_ID: '1' }, async () => {
    await assert.rejects(fulfillOrder(goodOrder, cfg), /PRINTIFY_API_TOKEN is not set/);
  });
  await withEnv({ PRINTIFY_API_TOKEN: 't', PRINTIFY_SHOP_ID: undefined }, async () => {
    await assert.rejects(fulfillOrder(goodOrder, cfg), /PRINTIFY_SHOP_ID is not set/);
  });
});

test('printify adapter builds a correct order and keeps it on hold by default', async () => {
  await withEnv({ PRINTIFY_API_TOKEN: 't', PRINTIFY_SHOP_ID: '1' }, async () => {
    let payload, sent = false;
    const client = { createOrder: async (p) => { payload = p; return { id: 'pfy_1' }; }, sendToProduction: async () => { sent = true; } };
    const r = await fulfillOrder(goodOrder, cfg, { client });
    assert.equal(r.status, 'submitted_on_hold');
    assert.equal(sent, false);
    assert.equal(payload.external_id, 'cs_test_1');
    assert.deepEqual(payload.line_items, [{ product_id: 'abc123', variant_id: 17428, quantity: 1 }]);
    assert.equal(payload.address_to.first_name, 'Ada');
    assert.equal(payload.address_to.last_name, 'Lovelace');
    assert.equal(payload.address_to.region, 'HI');
  });
});

test('toPrintifyAddress maps Stripe address fields', () => {
  const a = toPrintifyAddress(goodOrder);
  assert.equal(a.address1, '1 Main St');
  assert.equal(a.zip, '96720');
});

test('fulfillSession groups items by fulfiller using session metadata', async () => {
  const store = {
    config: { default_fulfiller: 'warehouse', fulfillers: { warehouse: { adapter: 'manual' }, printify: cfg } },
    catalog: { products: [
      { id: 'tee', fulfiller: 'printify', variants: [{ sku: 'TEE-17428', price_cents: 1299, printify_product_id: 'abc123', printify_variant_id: 17428 }] },
      { id: 'fruity-puppy-original', fulfiller: 'warehouse', variants: [{ sku: 'FP-2OZ', price_cents: 5999 }] },
    ] },
  };
  const session = {
    id: 'cs_test_2', payment_status: 'paid', customer_details: { email: 'a@example.com', name: 'Ada Lovelace' },
    collected_information: { shipping_details: { name: 'Ada Lovelace', address: { line1: '1 Main St', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } } },
    metadata: {
      item_0: JSON.stringify({ sku: 'TEE-17428', pid: 'tee', f: 'printify', q: 2, ppid: 'abc123', pvid: '17428' }),
      item_1: JSON.stringify({ sku: 'FP-2OZ', pid: 'fruity-puppy-original', f: 'warehouse', q: 1 }),
    },
  };
  const calls = [];
  const res = await fulfillSession(session, { store, fulfill: async (order, fcfg) => { calls.push({ order, fcfg }); return { ok: fcfg.adapter }; } });
  assert.deepEqual(Object.keys(res).sort(), ['printify', 'warehouse']);
  const pf = calls.find((c) => c.fcfg.adapter === 'printify');
  assert.equal(pf.order.items[0].quantity, 2);
  assert.equal(pf.order.shipping.line1, '1 Main St');
});

test('webhooks reject unsigned requests', async () => {
  await withEnv({ PRINTIFY_WEBHOOK_SECRET: 'sec', STRIPE_WEBHOOK_SECRET: 'whsec_x' }, async () => {
    const body = JSON.stringify({ type: 'order:shipment:created', resource: { id: 'o1', data: { carrier: { code: 'USPS', tracking_number: '9400' } } } });
    let r = await printifyWebhook(new Request('https://x/api/printify-webhook', { method: 'POST', body }));
    assert.equal(r.status, 401);
    r = await printifyWebhook(new Request('https://x/api/printify-webhook', { method: 'POST', body, headers: { 'x-pfy-signature': 'sha256=deadbeef' } }));
    assert.equal(r.status, 401);
    r = await stripeWebhook(new Request('https://x/api/stripe-webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=00' } }));
    assert.equal(r.status, 400);
  });
  await withEnv({ PRINTIFY_WEBHOOK_SECRET: undefined }, async () => {
    const r = await printifyWebhook(new Request('https://x/api/printify-webhook', { method: 'POST', body: '{}' }));
    assert.equal(r.status, 503);
  });
});

test('printify webhook accepts a signed shipment event', async () => {
  await withEnv({ PRINTIFY_WEBHOOK_SECRET: 'sec', PRINTIFY_API_TOKEN: undefined, PRINTIFY_TOKEN: undefined }, async () => {
    const body = JSON.stringify({ type: 'order:shipment:created', resource: { id: 'o1', type: 'order', data: { carrier: { code: 'USPS', tracking_number: '9400', tracking_url: 'https://t' } } } });
    const origErr = console.error; console.error = () => {};
    try {
      const r = await printifyWebhook(new Request('https://x/api/printify-webhook', { method: 'POST', body, headers: { 'x-pfy-signature': signPrintifyPayload(body, 'sec') } }));
      assert.equal(r.status, 200);
    } finally { console.error = origErr; }
  });
});
