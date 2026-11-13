// CJ Dropshipping Open API 2.0 client.
// Docs: https://developers.cjdropshipping.com/en/api/api2/api/auth.html
// CJ allows one call per second, so every request waits its turn.
const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

export class CJClient {
  constructor({ apiKey, accessToken, fetchImpl = fetch, minIntervalMs = 1100, sleep } = {}) {
    this.apiKey = apiKey || process.env.CJ_API_KEY;
    this.accessToken = accessToken || process.env.CJ_ACCESS_TOKEN || null;
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.last = 0;
    this.calls = 0;
    if (!this.apiKey && !this.accessToken) throw new Error('CJ_API_KEY missing');
  }

  async throttle() {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last = Date.now();
    this.calls++;
  }

  async raw(method, path, { query, body, auth = true } = {}) {
    if (auth && !this.accessToken) await this.login();
    await this.throttle();
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { 'CJ-Access-Token': this.accessToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.result === false || (data.code && data.code !== 200)) {
      const err = new Error(`CJ ${method} ${path} failed: ${res.status} ${data?.code ?? ''} ${data?.message ?? ''}`.trim());
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data.data;
  }

  async login() {
    if (!this.apiKey) throw new Error('CJ_API_KEY missing');
    const data = await this.raw('POST', '/authentication/getAccessToken', { body: { apiKey: this.apiKey }, auth: false });
    this.accessToken = data.accessToken;
    return data;
  }

  categories() { return this.raw('GET', '/product/getCategory'); }

  // One page of search results, flattened to a plain product array.
  async search({ keyWord, categoryId, countryCode, page = 1, size = 50, orderBy = 1 } = {}) {
    const data = await this.raw('GET', '/product/listV2', {
      query: { keyWord, categoryId, countryCode, page, size, orderBy, sort: 'desc' },
    });
    const products = [];
    for (const block of data?.content || []) products.push(...(block.productList || []));
    return { products, totalRecords: data?.totalRecords || 0, totalPages: data?.totalPages || 0 };
  }

  product(pid) { return this.raw('GET', '/product/query', { query: { pid } }); }

  freight({ from, to = 'US', items }) {
    return this.raw('POST', '/logistic/freightCalculate', {
      body: { startCountryCode: from, endCountryCode: to, products: items.map(i => ({ quantity: i.quantity || 1, vid: i.vid })) },
    });
  }

  createOrder(payload) { return this.raw('POST', '/shopping/order/createOrderV2', { body: payload }); }

  order(orderId) { return this.raw('GET', '/shopping/order/getOrderDetail', { query: { orderId } }); }
}

// Cheapest carrier from a freightCalculate response, or null when CJ offers none.
export function cheapestFreight(options) {
  let best = null;
  for (const o of options || []) {
    const price = Number(o.logisticPrice);
    if (!Number.isFinite(price)) continue;
    if (!best || price < best.price) best = { name: o.logisticName, price, aging: o.logisticAging || '' };
  }
  return best;
}
