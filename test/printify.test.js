import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintifyClient, PRINTIFY_BASE } from '../lib/printify.js';

test('client requires a token and never exposes it', () => {
  const saved = [process.env.PRINTIFY_API_TOKEN, process.env.PRINTIFY_TOKEN];
  delete process.env.PRINTIFY_API_TOKEN; delete process.env.PRINTIFY_TOKEN;
  try {
    assert.throws(() => new PrintifyClient(), /PRINTIFY_API_TOKEN is not set/);
  } finally {
    if (saved[0] !== undefined) process.env.PRINTIFY_API_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.PRINTIFY_TOKEN = saved[1];
  }
  const c = new PrintifyClient({ token: 'secret-token-value', shopId: '42' });
  assert.equal(JSON.stringify(c).includes('secret-token-value'), false);
  assert.equal(Object.keys(c).includes('token'), false);
});

test('client uses v1 paths, bearer auth, and fails loudly without shop id', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 1, variants: [] }), { status: 200 }); };
  const c = new PrintifyClient({ token: 'tok', shopId: '42', fetch });
  await c.getVariants(6, 3);
  await c.listPrintProviders(6);
  await c.createProduct({ title: 'x' });
  await c.getProduct('p1');
  await c.createOrder({});
  assert.deepEqual(calls.map((x) => x.url), [
    `${PRINTIFY_BASE}/catalog/blueprints/6/print_providers/3/variants.json`,
    `${PRINTIFY_BASE}/catalog/blueprints/6/print_providers.json`,
    `${PRINTIFY_BASE}/shops/42/products.json`,
    `${PRINTIFY_BASE}/shops/42/products/p1.json`,
    `${PRINTIFY_BASE}/shops/42/orders.json`,
  ]);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.ok(calls[0].init.headers['User-Agent']);
  const noShop = new PrintifyClient({ token: 'tok', shopId: '', fetch });
  assert.throws(() => noShop.createProduct({}), /PRINTIFY_SHOP_ID is not set/);
  assert.equal(typeof c.publishProduct, 'undefined');
});

test('client errors include status but not the token', async () => {
  const fetch = async () => new Response('{"error":"nope"}', { status: 401 });
  const c = new PrintifyClient({ token: 'super-secret', shopId: '1', fetch, retries: 0 });
  await assert.rejects(c.listShops(), (err) => err.status === 401 && !err.message.includes('super-secret'));
});

test('client retries GET on 429', async () => {
  let n = 0;
  const fetch = async () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : new Response('[]', { status: 200 }));
  const c = new PrintifyClient({ token: 't', shopId: '1', fetch, retries: 2 });
  assert.deepEqual(await c.listBlueprints(), []);
  assert.equal(n, 2);
});
