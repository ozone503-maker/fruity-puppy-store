import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { POST as checkout } from '../api/checkout.js';

process.env.STRIPE_SECRET_KEY ||= 'sk_test_x';
const cat = JSON.parse(readFileSync(new URL('../store/catalog.json', import.meta.url)));
const logo = cat.products.filter(p => p.collection === 'Logo');

test('label collection: 36 drafts, one image each, nothing buyable', () => {
  assert.equal(logo.length, 36);
  assert.equal(new Set(logo.map(p => p.id)).size, 36);
  for (const p of logo) {
    assert.equal(p.draft, true);
    assert.equal(p.images.length, 1, p.id);
    const f = new URL('../public/' + p.images[0], import.meta.url);
    assert.ok(existsSync(f) && statSync(f).size > 10000, p.images[0]);
    assert.ok(p.variants.length && p.variants.every(v => v.active === false && v.sku.startsWith('DRAFT-')), p.id);
  }
  assert.equal(new Set(logo.map(p => p.images[0])).size, 36);
});

test('checkout rejects every draft label SKU', async () => {
  const sku = logo[0].variants[0].sku;
  const req = new Request('https://x/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ sku, quantity: 1 }] }) });
  const res = await checkout(req, { fetchImpl: () => { throw new Error('must not call Stripe'); } });
  assert.equal(res.status, 400);
});
