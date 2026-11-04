import { PrintifyClient } from './printify.js';

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
};

export async function fulfillOrder(order, fulfillerConfig) {
  const adapterName = fulfillerConfig.adapter || 'manual';
  const adapter = adapters[adapterName];
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
  return adapter.fulfill(order, fulfillerConfig);
}
