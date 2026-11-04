import { loadStore } from './store.js';
export function publicCatalog() {
  const { config, catalog } = loadStore();
  return {
    store: { name: config.name, tagline: config.tagline, currency: config.currency, theme: config.theme },
    products: catalog.products.map(p => ({
      id: p.id, title: p.title, description: p.description,
      variants: p.variants.map(v => ({ sku: v.sku, title: v.title, price_cents: v.price_cents, available: v.active !== false }))
    }))
  };
}
