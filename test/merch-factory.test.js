import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retailPriceCents, selectVariants, upsertCatalog, pickMockups, run } from '../tools/merch-factory.js';

test('retail = cost x 1.20 rounded UP to .99', () => {
  assert.equal(retailPriceCents(1050), 1299); // 12.60 -> 12.99
  assert.equal(retailPriceCents(1000), 1299); // 12.00 -> 12.99
  assert.equal(retailPriceCents(999), 1199);  // 11.988 -> 11.99
  assert.equal(retailPriceCents(1082), 1299); // 12.984 -> 12.99
  assert.equal(retailPriceCents(1083), 1399); // 12.996 -> 13.99
  assert.equal(retailPriceCents(1302), 1599); // 15.624 -> 15.99
  assert.equal(retailPriceCents(50), 99);
  assert.throws(() => retailPriceCents(0));
  assert.throws(() => retailPriceCents(10.5));
});

test('selectVariants filters by color/size/position', () => {
  const vs = [
    { id: 1, title: 'Black / S', options: { color: 'Black', size: 'S' }, placeholders: [{ position: 'front' }] },
    { id: 2, title: 'Black / M', options: { color: 'Black', size: 'M' }, placeholders: [{ position: 'back' }] },
    { id: 3, title: 'White / S', options: { color: 'White', size: 'S' }, placeholders: [{ position: 'front' }] },
  ];
  assert.deepEqual(selectVariants(vs, { colors: ['black'] }).map((v) => v.id), [1]);
  assert.deepEqual(selectVariants(vs, { sizes: ['S'] }).map((v) => v.id), [1, 3]);
  assert.throws(() => selectVariants(vs, { colors: ['red'] }), /No variants match/);
});

test('upsertCatalog dedupes by printify product id and keeps slugs unique', () => {
  let cat = { products: [{ id: 'tee', printify_product_id: null }] };
  let r = upsertCatalog(cat, { id: 'tee', printify_product_id: 'p1', title: 'A' });
  assert.equal(r.action, 'added'); assert.equal(r.id, 'tee-2');
  r = upsertCatalog(r.catalog, { id: 'tee', printify_product_id: 'p1', title: 'B' });
  assert.equal(r.action, 'updated'); assert.equal(r.id, 'tee-2');
  assert.equal(r.catalog.products.length, 2);
  assert.equal(r.catalog.products[1].title, 'B');
});

test('pickMockups prefers default and filters to selected variants', () => {
  const imgs = [
    { src: 'a', variant_ids: [9], is_default: true },
    { src: 'b', variant_ids: [1, 2], is_default: false },
    { src: 'c', variant_ids: [2], is_default: true },
    { src: 'b', variant_ids: [1], is_default: false },
  ];
  assert.deepEqual(pickMockups(imgs, [1, 2]), ['c', 'b']);
});

test('dry run works without a token and writes only the scratch catalog', async () => {
  const saved = { a: process.env.PRINTIFY_API_TOKEN, b: process.env.PRINTIFY_TOKEN };
  const dir = mkdtempSync(join(tmpdir(), 'merch-'));
  const catalogPath = join(dir, 'catalog.json');
  const origLog = console.log; console.log = () => {};
  try {
    const env = {};
    const r = await run(['--dry-run', '--blueprint', '6', '--provider', '3', '--colors', 'Solid Black', '--sizes', 'S,M', '--title', 'Test Tee', '--catalog', catalogPath], { env });
    assert.equal(r.ok, true);
    assert.ok(existsSync(catalogPath));
    const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
    assert.equal(cat.products.length, 1);
    assert.equal(cat.products[0].variants[0].price_cents, 1299);
    assert.equal(cat.products[0].blueprint_id, 6);
    assert.equal(cat.products[0].print_provider_id, 3);
    // run again: dedupe
    await run(['--dry-run', '--blueprint', '6', '--provider', '3', '--colors', 'Solid Black', '--sizes', 'S,M', '--title', 'Test Tee', '--catalog', catalogPath], { env });
    assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8')).products.length, 1);
  } finally {
    console.log = origLog;
    if (saved.a !== undefined) process.env.PRINTIFY_API_TOKEN = saved.a;
    if (saved.b !== undefined) process.env.PRINTIFY_TOKEN = saved.b;
  }
});

test('live mode fails loudly without PRINTIFY_API_TOKEN / PRINTIFY_SHOP_ID', async () => {
  await assert.rejects(run(['--blueprint', '6'], { env: {} }), (e) => e.exitCode === 2 && /PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID/.test(e.message));
  await assert.rejects(run(['--blueprint', '6'], { env: { PRINTIFY_API_TOKEN: 't' } }), /PRINTIFY_SHOP_ID/);
});

test('create flow: unpublished product, cost-based pricing, mockups, catalog upsert (mocked API)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merch-'));
  const catalogPath = join(dir, 'catalog.json');
  const calls = [];
  const fake = {
    listBlueprints: async () => [{ id: 6, title: 'Unisex Heavy Cotton Tee', brand: 'Gildan', model: '5000' }],
    listPrintProviders: async () => [{ id: 3, title: 'DJ' }],
    getVariants: async () => ({ variants: [
      { id: 17427, title: 'Solid Black / S', options: { color: 'Solid Black', size: 'S' }, placeholders: [{ position: 'front' }] },
      { id: 17428, title: 'Solid Black / M', options: { color: 'Solid Black', size: 'M' }, placeholders: [{ position: 'front' }] },
    ] }),
    uploadImage: async (b) => { calls.push(['upload', b]); return { id: 'img1' }; },
    createProduct: async (b) => { calls.push(['create', b]); return { id: 'prod1' }; },
    getProduct: async () => ({ id: 'prod1', variants: [{ id: 17427, cost: 1050, price: 9999 }, { id: 17428, cost: 1083, price: 9999 }, { id: 99, cost: 1, price: 9999 }],
      images: [{ src: 'https://images-api.printify.com/mockup/1.jpg', variant_ids: [17427, 17428], position: 'front', is_default: true }] }),
    updateProduct: async (id, b) => { calls.push(['update', b]); return {}; },
  };
  const origLog = console.log; console.log = () => {};
  try {
    const r = await run(['--create', '--blueprint', '6', '--provider', '3', '--colors', 'Solid Black', '--image', 'https://example.com/design.png', '--title', 'FP Tee', '--catalog', catalogPath],
      { env: { PRINTIFY_API_TOKEN: 't', PRINTIFY_SHOP_ID: '1' }, clientFactory: () => fake });
    assert.equal(r.printifyProductId, 'prod1');
  } finally { console.log = origLog; }
  assert.ok(!calls.some(([k]) => k === 'publish'));
  const upd = calls.find(([k]) => k === 'update')[1];
  assert.deepEqual(upd.variants.find((v) => v.id === 17427), { id: 17427, price: 1299, is_enabled: true });
  assert.deepEqual(upd.variants.find((v) => v.id === 17428), { id: 17428, price: 1399, is_enabled: true });
  assert.equal(upd.variants.find((v) => v.id === 99).is_enabled, false);
  const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const p = cat.products[0];
  assert.equal(p.printify_product_id, 'prod1');
  assert.deepEqual(p.images, ['https://images-api.printify.com/mockup/1.jpg']);
  assert.equal(p.variants[0].printify_variant_id, 17427);
  assert.equal(p.variants[0].size, 'S');
  assert.equal(p.variants[0].color, 'Solid Black');
  assert.equal(p.variants[1].price_cents, 1399);
});
