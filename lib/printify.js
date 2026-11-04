// Printify REST API v1 client.
// Docs: https://developers.printify.com/
//
// Secrets: the API token is read only from env (PRINTIFY_API_TOKEN) or passed
// in by the caller. It is never logged and never included in error messages.
// This client intentionally has NO publish method: creating a product leaves it
// unpublished, and publishing is a manual, operator-approved step.

export const PRINTIFY_BASE = 'https://api.printify.com/v1';
const USER_AGENT = 'fruity-puppy-store/1.0';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read the Printify token from env. PRINTIFY_TOKEN is accepted as a legacy alias. */
export function printifyTokenFromEnv(env = process.env, name) {
  if (name) return env[name] || undefined;
  return env.PRINTIFY_API_TOKEN || env.PRINTIFY_TOKEN || undefined;
}

export class PrintifyError extends Error {
  constructor(message, { status, method, path, body } = {}) {
    super(message);
    this.name = 'PrintifyError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body; // response body from Printify (never contains our token)
  }
}

const seg = (v, label) => {
  if (v === undefined || v === null || v === '') throw new PrintifyError(`Printify: missing ${label}`);
  return encodeURIComponent(String(v));
};

export class PrintifyClient {
  /**
   * @param {{token?: string, shopId?: string|number, fetch?: typeof fetch, timeoutMs?: number, retries?: number}} opts
   */
  constructor({ token, shopId, fetch: fetchImpl, timeoutMs, retries } = {}) {
    const t = token || printifyTokenFromEnv();
    if (!t) throw new PrintifyError('PRINTIFY_API_TOKEN is not set (Printify personal access token). Refusing to continue.');
    // Keep the token off enumerable props so it is never serialized/logged by accident.
    Object.defineProperty(this, 'token', { value: t, enumerable: false, writable: false });
    this.shopId = shopId ?? process.env.PRINTIFY_SHOP_ID ?? undefined;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retries = retries ?? 2;
  }

  toJSON() { return { shopId: this.shopId }; }

  requireShop() {
    if (!this.shopId) throw new PrintifyError('PRINTIFY_SHOP_ID is not set. Find it with GET /v1/shops.json (see store/OPERATOR.md).');
    return seg(this.shopId, 'shop id');
  }

  async request(method, path, body) {
    const url = `${PRINTIFY_BASE}${path}`;
    // Only idempotent GETs are retried; POST/PUT are never retried automatically.
    const maxAttempts = method === 'GET' ? this.retries + 1 : 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json;charset=utf-8',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = new PrintifyError(`Printify ${method} ${path} network error: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, { method, path });
        if (attempt < maxAttempts) { await sleep(backoff(attempt)); continue; }
        throw lastErr;
      }

      const text = await res.text();
      if (res.ok) {
        if (!text) return {};
        try { return JSON.parse(text); } catch {
          throw new PrintifyError(`Printify ${method} ${path} returned non-JSON response`, { status: res.status, method, path });
        }
      }

      const snippet = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      lastErr = new PrintifyError(`Printify ${method} ${path} failed with ${res.status}: ${snippet}`, { status: res.status, method, path, body: snippet });
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : backoff(attempt));
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  // ---- Shops -------------------------------------------------------------
  listShops() { return this.request('GET', '/shops.json'); }

  // ---- Catalog (read-only, separate 100 req/min limit) --------------------
  listBlueprints() { return this.request('GET', '/catalog/blueprints.json'); }
  getBlueprint(blueprintId) { return this.request('GET', `/catalog/blueprints/${seg(blueprintId, 'blueprint id')}.json`); }
  listPrintProviders(blueprintId) {
    return this.request('GET', `/catalog/blueprints/${seg(blueprintId, 'blueprint id')}/print_providers.json`);
  }
  /** Returns { id, title, variants: [{ id, title, options: {color,size}, placeholders }] } */
  getVariants(blueprintId, printProviderId, { showOutOfStock = false } = {}) {
    const q = showOutOfStock ? '?show-out-of-stock=1' : '';
    return this.request('GET', `/catalog/blueprints/${seg(blueprintId, 'blueprint id')}/print_providers/${seg(printProviderId, 'print provider id')}/variants.json${q}`);
  }
  getShipping(blueprintId, printProviderId) {
    return this.request('GET', `/catalog/blueprints/${seg(blueprintId, 'blueprint id')}/print_providers/${seg(printProviderId, 'print provider id')}/shipping.json`);
  }

  // ---- Uploads -----------------------------------------------------------
  uploadImage({ file_name, contents, url }) {
    if (!file_name) throw new PrintifyError('uploadImage: file_name is required');
    if (!url && !contents) throw new PrintifyError('uploadImage: url or base64 contents is required');
    return this.request('POST', '/uploads/images.json', url ? { file_name, url } : { file_name, contents });
  }

  // ---- Products (never published from code) -------------------------------
  listProducts({ page = 1, limit = 50 } = {}) {
    return this.request('GET', `/shops/${this.requireShop()}/products.json?page=${Number(page)}&limit=${Number(limit)}`);
  }
  createProduct(data) { return this.request('POST', `/shops/${this.requireShop()}/products.json`, data); }
  getProduct(productId) { return this.request('GET', `/shops/${this.requireShop()}/products/${seg(productId, 'product id')}.json`); }
  updateProduct(productId, data) {
    return this.request('PUT', `/shops/${this.requireShop()}/products/${seg(productId, 'product id')}.json`, data);
  }

  // ---- Orders ------------------------------------------------------------
  getOrder(orderId) { return this.request('GET', `/shops/${this.requireShop()}/orders/${seg(orderId, 'order id')}.json`); }
  createOrder(data) { return this.request('POST', `/shops/${this.requireShop()}/orders.json`, data); }
  sendToProduction(orderId) {
    return this.request('POST', `/shops/${this.requireShop()}/orders/${seg(orderId, 'order id')}/send_to_production.json`);
  }
}

function backoff(attempt) { return Math.min(1000 * 2 ** (attempt - 1), 8000); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
