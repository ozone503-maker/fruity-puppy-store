const BASE = 'https://api.printify.com/v1';

export class PrintifyClient {
  constructor({ token, shopId } = {}) {
    this.token = token || process.env.PRINTIFY_TOKEN;
    this.shopId = shopId || process.env.PRINTIFY_SHOP_ID;
    if (!this.token) throw new Error('PRINTIFY_TOKEN missing');
  }

  async request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'fruity-puppy-store/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Printify ${method} ${path} ${res.status}: ${text}`);
    }
    return res.json();
  }

  async listShops() {
    return this.request('GET', '/shops.json');
  }

  async uploadImage({ file_name, contents, url }) {
    const body = url ? { file_name, url } : { file_name, contents };
    return this.request('POST', '/uploads/images.json', body);
  }

  async createProduct(data) {
    if (!this.shopId) throw new Error('PRINTIFY_SHOP_ID missing');
    return this.request('POST', `/shops/${this.shopId}/products.json`, data);
  }

  async getProduct(productId) {
    return this.request('GET', `/shops/${this.shopId}/products/${productId}.json`);
  }

  async createOrder(data) {
    return this.request('POST', `/shops/${this.shopId}/orders.json`, data);
  }

  async sendToProduction(orderId) {
    return this.request('POST', `/shops/${this.shopId}/orders/${orderId}/send_to_production.json`);
  }

  async listBlueprints() {
    return this.request('GET', '/catalog/blueprints.json');
  }

  async getBlueprint(id) {
    return this.request('GET', `/catalog/blueprints/${id}.json`);
  }
}
