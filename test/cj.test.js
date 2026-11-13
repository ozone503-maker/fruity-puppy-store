import test from 'node:test';
import assert from 'node:assert/strict';
import { CJClient, cheapestFreight } from '../lib/cj.js';
import { retailCents, plainText, buildProduct, runImport, stockCountry } from '../tools/cj-import.js';
import { cjOrderPayloads, cjOrderNumber, fulfillOrder } from '../lib/fulfillment.js';
import { pagedCatalog, isPaged, publicCatalog } from '../lib/commerce.js';
import { GET as catalogGet } from '../api/catalog.js';

const ok = data => new Response(JSON.stringify({ code: 200, result: true, message: 'Success', data }), { status: 200 });

function detail(pid, { us = 5, cn = 100, price = 10 } = {}) {
  return {
    pid, productNameEn: `Solar Lantern ${pid}`, productSku: `CJ${pid}`, bigImage: `https://img.example/${pid}.jpg`,
    productImageSet: [`https://img.example/${pid}.jpg`, `https://img.example/${pid}-2.jpg`],
    description: '<p>Bright <b>light</b>.</p><img src="x.jpg"><p>Charges by sun.</p>',
    variants: [
      { vid: `${pid}-V1`, variantSku: `CJ${pid}-A`, variantKey: 'Black', variantSellPrice: price, inventories: [{ countryCode: 'US', totalInventory: us }, { countryCode: 'CN', totalInventory: cn }] },
      { vid: `${pid}-V2`, variantSku: `CJ${pid}-B`, variantKey: 'Green', variantSellPrice: price + 2, inventories: [{ countryCode: 'CN', totalInventory: cn }] },
    ],
  };
}

function fakeCJ(log = []) {
  return async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api2.0/v1', '');
    log.push({ path, method: init.method, token: init.headers['CJ-Access-Token'], body: init.body ? JSON.parse(init.body) : null, query: Object.fromEntries(u.searchParams) });
    if (path === '/authentication/getAccessToken') return ok({ accessToken: 'tok-1' });
    if (path === '/product/listV2') return ok({ totalRecords: 3, totalPages: 1, content: [{ productList: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }] }] });
    if (path === '/product/query') {
      const pid = u.searchParams.get('pid');
      if (pid === 'P3') return ok(detail('P3', { us: 0, cn: 0 }));
      return ok(detail(pid, pid === 'P2' ? { us: 0 } : {}));
    }
    if (path === '/logistic/freightCalculate') return ok([{ logisticName: 'Slow Boat', logisticPrice: 9.5, logisticAging: '20-30' }, { logisticName: 'USPS+', logisticPrice: 4.25, logisticAging: '3-7' }]);
    if (path === '/shopping/order/createOrderV2') return ok({ orderId: 'CJ-ORDER-1', orderStatus: 'CREATED', orderAmount: '14.25' });
    return new Response(JSON.stringify({ code: 1600100, result: false, message: 'Param error', data: null }), { status: 200 });
  };
}
const client = log => new CJClient({ apiKey: 'key', fetchImpl: fakeCJ(log), minIntervalMs: 0 });

test('retail price is landed cost x multiplier, rounded up to .99', () => {
  assert.equal(retailCents(10, 0, 1.2), 1299);     // 12.00 -> 12.99
  assert.equal(retailCents(8, 2.825, 1.2), 1299);  // 12.99 stays
  assert.equal(retailCents(10, 0.84, 1.2), 1399);  // 13.008 -> 13.99
  assert.equal(retailCents(1, 0.2, 1.2), 199);
});

test('plainText strips supplier HTML and images', () => {
  assert.equal(plainText('<p>Bright <b>light</b>.</p><img src="x"><p>Charges by sun.</p>'), 'Bright light.\nCharges by sun.');
});

test('client logs in once, sends the token, and surfaces CJ errors', async () => {
  const log = [];
  const cj = client(log);
  const found = await cj.search({ keyWord: 'lantern', countryCode: 'US' });
  assert.equal(found.products.length, 3);
  assert.equal(log[0].path, '/authentication/getAccessToken');
  assert.deepEqual(log[0].body, { apiKey: 'key' });
  assert.equal(log[1].token, 'tok-1');
  assert.equal(log[1].query.keyWord, 'lantern');
  await cj.search({ keyWord: 'x' });
  assert.equal(log.filter(l => l.path === '/authentication/getAccessToken').length, 1);
  await assert.rejects(() => cj.raw('GET', '/nope'), /1600100 Param error/);
});

test('cheapestFreight picks the lowest price', () => {
  assert.deepEqual(cheapestFreight([{ logisticName: 'A', logisticPrice: 9 }, { logisticName: 'B', logisticPrice: 4, logisticAging: '3-7' }]), { name: 'B', price: 4, aging: '3-7' });
  assert.equal(cheapestFreight([]), null);
});

test('buildProduct keeps one origin, real variant ids, and prices from cost plus freight', async () => {
  const plan = { ship_from: ['US', 'CN'], pricing: { multiplier: 1.2 } };
  const dept = { id: 'survival-light', name: 'Light', group: 'Survival Tech' };
  const { product } = await buildProduct(detail('P1'), dept, plan, client());
  assert.equal(product.ships_from, 'US');
  assert.equal(product.variants.length, 1);           // only the variant stocked in the US
  assert.equal(product.variants[0].cj_vid, 'P1-V1');
  assert.equal(product.variants[0].price_cents, 1799); // (10 + 4.25) * 1.2 = 17.10 -> 17.99
  assert.equal(product.cj_logistic, 'USPS+');
  assert.equal(product.fulfiller, 'cj');
  assert.match(product.shipping_note, /Ships from the US, about 3-7 days/);
  assert.equal(stockCountry(detail('P2', { us: 0 }).variants[0], ['US', 'CN']), 'CN');
  const none = await buildProduct(detail('P3', { us: 0, cn: 0 }), dept, plan, client());
  assert.match(none.skip, /no stock/);
});

test('runImport fills departments, skips empties, and does not duplicate on a second run', async () => {
  const plan = { ship_from: ['US', 'CN'], per_department: 5, pricing: { multiplier: 1.2 }, departments: [{ id: 'd1', name: 'Light', group: 'Survival Tech', keywords: ['lantern'] }] };
  const catalog = { products: [] };
  const cj = client();
  const stats = await runImport({ client: cj, plan, catalog, log: () => {} });
  assert.equal(stats.added, 2);
  assert.equal(stats.skipped, 1);
  assert.deepEqual(catalog.products.map(p => p.ships_from), ['US', 'CN']);
  const again = await runImport({ client: cj, plan, catalog, log: () => {} });
  assert.equal(again.added, 0);
  assert.equal(catalog.products.length, 2);
  assert.equal(new Set(catalog.products.flatMap(p => p.variants.map(v => v.sku))).size, 3);
});

const order = {
  id: 'cs_live_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6a7B8c9D0',
  email: 'buyer@example.com',
  shipping: { name: 'Pat Buyer', address: { line1: '1 Main St', line2: '', city: 'Hilo', state: 'HI', postal_code: '96720', country: 'US' } },
  items: [
    { sku: 'A', quantity: 2, fulfiller_adapter: 'cj', cj_vid: 'V-A', ships_from: 'US', cj_logistic: 'USPS+' },
    { sku: 'B', quantity: 1, fulfiller_adapter: 'cj', cj_vid: 'V-B', ships_from: 'CN', cj_logistic: 'CJPacket' },
    { sku: 'TEE', quantity: 1, fulfiller_adapter: 'printify' },
  ],
};

test('CJ orders split by origin, stay under 50 chars, and are created unpaid', async () => {
  const payloads = cjOrderPayloads(order, {});
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every(p => p.orderNumber.length <= 50));
  assert.equal(cjOrderNumber(order.id, 'US'), payloads[0].orderNumber);
  assert.equal(payloads[0].payType, 3);
  assert.deepEqual(payloads[0].products, [{ vid: 'V-A', quantity: 2, storeLineItemId: 'A' }]);
  assert.equal(payloads[1].fromCountryCode, 'CN');
  assert.throws(() => cjOrderPayloads({ ...order, items: [{ sku: 'X', fulfiller_adapter: 'cj' }] }), /Missing cj_vid/);
  assert.throws(() => cjOrderPayloads({ ...order, shipping: {} }), /address incomplete/);

  const log = [];
  const result = await fulfillOrder(order, { adapter: 'cj' }, { client: client(log) });
  assert.equal(result.status, 'submitted');
  assert.equal(result.paid, false);
  assert.equal(result.cj_orders.length, 2);
  const created = log.filter(l => l.path === '/shopping/order/createOrderV2');
  assert.equal(created.length, 2);
  assert.equal(created[0].body.logisticName, 'USPS+');
  assert.equal(created[0].body.shippingProvince, 'HI');
});

test('brobots-tech is a paged brand; other brands still get the whole catalog', async () => {
  assert.equal(isPaged('brobots-tech'), true);
  assert.equal(isPaged('brobots'), false);
  assert.equal(isPaged(undefined), false);
  const res = await catalogGet(new Request('https://x/api/catalog?brand=brobots-tech'));
  const body = await res.json();
  assert.equal(body.store.paged, true);
  assert.equal(body.store.skin, 'bt');
  assert.ok(Array.isArray(body.products));
  const bb = await (await catalogGet(new Request('https://x/api/catalog?brand=brobots'))).json();
  assert.equal(bb.products.length, publicCatalog('brobots').products.length);
  assert.equal(bb.store.paged, undefined);
  assert.equal((await catalogGet(new Request('https://x/api/catalog?brand=nope'))).status, 400);
  assert.ok(pagedCatalog('brobots-tech', { q: 'zzz' }).pages >= 1);
});

test('no cost or CJ ids leak into the public catalog', () => {
  const text = JSON.stringify(pagedCatalog('brobots-tech', {}));
  assert.ok(!/cj_cost_cents|cj_vid|cj_freight/.test(text));
});
