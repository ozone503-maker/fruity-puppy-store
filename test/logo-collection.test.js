import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { POST as checkout } from '../api/checkout.js';

process.env.STRIPE_SECRET_KEY ||= 'sk_test_x';
const cat = JSON.parse(readFileSync(new URL('../store/catalog.json', import.meta.url)));
const logo = cat.products.filter(p => p.collection === 'Logo');
const live = logo.filter(p => !p.draft);
const drafts = logo.filter(p => p.draft);
const post = items => new Request('https://x/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
const stripeOk = cap => async (url, init) => { cap.push(init); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }), { status: 200 }); };

test('label collection: 36 listings, one image each', () => {
  assert.equal(logo.length, 36);
  assert.equal(new Set(logo.map(p => p.images[0])).size, 36);
  for (const p of logo) {
    assert.equal(p.images.length, 1, p.id);
    const f = new URL('../public/' + p.images[0], import.meta.url);
    assert.ok(existsSync(f) && statSync(f).size > 10000, p.images[0]);
  }
});

test('24 live listings map every variant to a real Printify product and variant', () => {
  assert.equal(live.length, 24);
  for (const p of live) {
    assert.match(p.printify_product_id, /^[0-9a-f]{24}$/);
    assert.ok(p.variants.length >= 15, p.id);
    for (const v of p.variants) {
      assert.equal(v.printify_product_id, p.printify_product_id);
      assert.ok(Number.isInteger(v.printify_variant_id));
      assert.ok(!v.sku.startsWith('DRAFT-'));
      assert.ok(v.price_cents > v.cost_cents, `${v.sku} price below printer cost`);
    }
  }
});

test('12 drafts (beach hoodies, blankets) stay unbuyable', async () => {
  assert.equal(drafts.length, 12);
  assert.ok(drafts.every(p => /beach-hoodie|blanket/.test(p.id)));
  assert.ok(drafts.every(p => p.variants.every(v => v.active === false)));
  const res = await checkout(post([{ sku: drafts[0].variants[0].sku, quantity: 1 }]), { fetchImpl: () => { throw new Error('must not call Stripe'); } });
  assert.equal(res.status, 400);
});

test('checkout accepts a live label SKU at the catalog price', async () => {
  const v = live[0].variants[0]; const cap = [];
  const res = await checkout(post([{ sku: v.sku, quantity: 1 }]), { fetchImpl: stripeOk(cap) });
  assert.equal(res.status, 200);
  const p = new URLSearchParams(cap[0].body);
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), String(v.price_cents));
  assert.equal(p.get('line_items[0][price_data][product_data][metadata][sku]'), v.sku);
});
