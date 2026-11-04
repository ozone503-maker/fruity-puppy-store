import { PrintifyClient, printifyTokenFromEnv } from './printify.js';

// Fulfillment adapters. Every adapter fails loudly (throws) on missing data
// instead of silently filling in defaults, so a bad order never reaches a
// print provider with a guessed address or the wrong product.

export class FulfillmentError extends Error {
  constructor(message) { super(message); this.name = 'FulfillmentError'; }
}

const required = (value, label) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new FulfillmentError(`Missing ${label}`);
  }
  return String(value).trim();
};

/** Build a Printify address_to from our order shape. Throws on anything missing. */
export function toPrintifyAddress(order) {
  const a = order.shipping || {};
  const country = required(a.country, 'shipping country').toUpperCase();
  let first = a.first_name, last = a.last_name;
  if (!first && a.name) {
    const parts = String(a.name).trim().split(/\s+/);
    first = parts.shift();
    last = parts.join(' ');
  }
  const region = a.region || a.state || '';
  if (['US', 'CA', 'AU'].includes(country)) required(region, `shipping region/state for ${country}`);
  return {
    first_name: required(first, 'shipping first name'),
    last_name: last ? String(last).trim() : '',
    email: required(order.email || a.email, 'customer email'),
    phone: a.phone || '',
    country,
    region,
    address1: required(a.address1 || a.line1, 'shipping address line 1'),
    address2: a.address2 || a.line2 || '',
    city: required(a.city, 'shipping city'),
    zip: required(a.zip || a.postal_code, 'shipping postal code'),
  };
}

/** Build Printify line_items. Throws if any item lacks Printify ids or a valid quantity. */
export function toPrintifyLineItems(order) {
  const items = order.items || [];
  if (!items.length) throw new FulfillmentError(`Order ${order.id}: no items to fulfill`);
  return items.map((item, i) => {
    const label = item.sku || `item #${i}`;
    if (!item.printify_product_id) throw new FulfillmentError(`Order ${order.id}: missing printify_product_id for ${label}`);
    const variantId = Number(item.printify_variant_id);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      throw new FulfillmentError(`Order ${order.id}: missing or invalid printify_variant_id for ${label}`);
    }
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) throw new FulfillmentError(`Order ${order.id}: invalid quantity for ${label}`);
    return { product_id: String(item.printify_product_id), variant_id: variantId, quantity };
  });
}

const adapters = {
  manual: {
    async fulfill(order) {
      console.log(`[fulfillment] manual fulfillment needed for order ${order.id} (${(order.items || []).length} item(s))`);
      return { status: 'manual', note: 'Warehouse will handle' };
    },
  },
  printify: {
    async fulfill(order, config, deps = {}) {
      required(order.id, 'order id');
      const tokenEnv = config.token_env || 'PRINTIFY_API_TOKEN';
      const shopEnv = config.shop_id_env || 'PRINTIFY_SHOP_ID';
      const token = printifyTokenFromEnv(process.env, tokenEnv) || printifyTokenFromEnv(process.env);
      const shopId = process.env[shopEnv];
      if (!token) throw new FulfillmentError(`Printify fulfillment: env ${tokenEnv} is not set`);
      if (!shopId) throw new FulfillmentError(`Printify fulfillment: env ${shopEnv} is not set`);

      // Validate everything before any network call.
      const payload = {
        external_id: String(order.id),
        label: String(order.id).slice(0, 100),
        line_items: toPrintifyLineItems(order),
        shipping_method: Number(config.shipping_method || 1), // 1 = standard
        send_shipping_notification: Boolean(config.send_shipping_notification),
        address_to: toPrintifyAddress(order),
      };

      const client = deps.client || new PrintifyClient({ token, shopId });
      const created = await client.createOrder(payload);
      if (!created?.id) throw new FulfillmentError(`Printify did not return an order id for ${order.id}`);
      // Off by default: orders stay "on hold" in Printify until an operator
      // reviews them, unless config.send_to_production is explicitly true.
      if (config.send_to_production === true) {
        await client.sendToProduction(created.id);
        return { status: 'in_production', printify_order_id: created.id };
      }
      return { status: 'submitted_on_hold', printify_order_id: created.id };
    },
  },
};

export async function fulfillOrder(order, fulfillerConfig, deps) {
  if (!fulfillerConfig) throw new FulfillmentError(`No fulfiller config for order ${order?.id}`);
  const adapterName = fulfillerConfig.adapter;
  if (!adapterName) throw new FulfillmentError(`Fulfiller config for order ${order?.id} has no adapter`);
  const adapter = adapters[adapterName];
  if (!adapter) throw new FulfillmentError(`Unknown fulfillment adapter: ${adapterName}`);
  return adapter.fulfill(order, fulfillerConfig, deps);
}
