import { PrintifyClient } from './printify.js';
import { CJClient, cheapestFreight } from './cj.js';
import { createHash } from 'node:crypto';

// CJ order numbers are capped at 50 characters; Stripe session ids are longer.
export function cjOrderNumber(orderId, country) {
  return `bb-${createHash('sha1').update(String(orderId)).digest('hex').slice(0, 20)}-${country}`;
}

// One CJ order per origin country, because CJ ships each order from a single warehouse region.
export function cjOrderPayloads(order, config = {}) {
  const groups = new Map();
  for (const item of order.items || []) {
    if (item.fulfiller_adapter && item.fulfiller_adapter !== 'cj') continue;
    if (!item.cj_vid) throw new Error(`Missing cj_vid for ${item.sku}`);
    const from = item.ships_from || 'CN';
    if (!groups.has(from)) groups.set(from, []);
    groups.get(from).push(item);
  }
  if (!groups.size) throw new Error('No CJ items in order');
  const ship = order.shipping || {};
  const a = ship.address || {};
  if (!a.line1 || !a.city || !a.country) throw new Error('Shipping address incomplete');
  return [...groups.entries()].map(([from, items]) => ({
    orderNumber: cjOrderNumber(order.id, from),
    shippingCountryCode: a.country,
    shippingCountry: a.country === 'US' ? 'United States' : a.country,
    shippingProvince: a.state || '',
    shippingCity: a.city,
    shippingZip: a.postal_code || '',
    shippingCustomerName: ship.name || 'Customer',
    shippingAddress: a.line1,
    shippingAddress2: a.line2 || '',
    shippingPhone: ship.phone || '',
    email: order.email || '',
    remark: '',
    // 3 = create the order in CJ without paying. Jessie pays in the CJ dashboard.
    payType: config.pay_type || 3,
    logisticName: items[0].cj_logistic || '',
    fromCountryCode: from,
    platform: 'Api',
    orderFlow: 1,
    products: items.map(i => ({ vid: i.cj_vid, quantity: i.quantity || 1, storeLineItemId: i.sku })),
  }));
}

const adapters = {
  manual: {
    async fulfill(order, config) {
      console.log('Manual fulfill for', order.id);
      return { status: 'manual', note: 'Warehouse will handle' };
    },
  },
  printify: {
    async fulfill(order, config) {
      const client = new PrintifyClient({
        token: process.env[config.token_env || 'PRINTIFY_TOKEN'],
        shopId: process.env[config.shop_id_env || 'PRINTIFY_SHOP_ID'],
      });
      const line_items = [];
      for (const item of order.items || []) {
        if (!item.printify_product_id || !item.printify_variant_id) {
          throw new Error(`Missing printify_product_id or printify_variant_id for ${item.sku}`);
        }
        line_items.push({
          product_id: item.printify_product_id,
          variant_id: Number(item.printify_variant_id),
          quantity: item.quantity || 1,
        });
      }
      if (!line_items.length) throw new Error('No Printify items in order');
      const address = order.shipping || {};
      const payload = {
        external_id: order.id,
        label: order.id,
        line_items,
        shipping_method: 1,
        send_shipping_notification: false,
        address_to: {
          first_name: address.first_name || 'Customer',
          last_name: address.last_name || '',
          email: order.email || address.email || 'orders@fruitypuppy.com',
          phone: address.phone || '',
          country: address.country || 'US',
          region: address.region || address.state || '',
          address1: address.address1 || address.line1 || '',
          address2: address.address2 || '',
          city: address.city || '',
          zip: address.zip || address.postal_code || '',
        },
      };
      const created = await client.createOrder(payload);
      if (config.send_to_production) {
        await client.sendToProduction(created.id);
      }
      return { status: 'submitted', printify_order_id: created.id };
    },
  },
  cj: {
    async fulfill(order, config, { client } = {}) {
      const cj = client || new CJClient({ apiKey: process.env[config.api_key_env || 'CJ_API_KEY'] });
      const submitted = [];
      for (const payload of cjOrderPayloads(order, config)) {
        // Re-quote the carrier for the real basket; fall back to the one stored at import.
        try {
          const best = cheapestFreight(await cj.freight({
            from: payload.fromCountryCode, to: payload.shippingCountryCode,
            items: payload.products.map(p => ({ vid: p.vid, quantity: p.quantity })),
          }));
          if (best) payload.logisticName = best.name;
        } catch {}
        if (!payload.logisticName) throw new Error(`No carrier for CJ order from ${payload.fromCountryCode}`);
        const created = await cj.createOrder(payload);
        submitted.push({ cj_order_id: created.orderId, order_number: payload.orderNumber, from: payload.fromCountryCode, carrier: payload.logisticName, status: created.orderStatus || null, amount: created.orderAmount || null });
      }
      return { status: 'submitted', paid: (config.pay_type || 3) === 2, cj_orders: submitted };
    },
  },
};

export async function fulfillOrder(order, fulfillerConfig, deps) {
  const adapterName = fulfillerConfig.adapter || 'manual';
  const adapter = adapters[adapterName];
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
  return adapter.fulfill(order, fulfillerConfig, deps);
}
