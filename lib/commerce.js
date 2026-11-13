import { loadStore } from './store.js';
export function publicCatalog(brand) {
  const { config, catalog } = loadStore(brand);
  return {
    store: { name: config.name, tagline: config.tagline, currency: config.currency, theme: config.theme },
    products: catalog.products.map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      collection: p.collection,
      images: p.images || [],
      size_chart: p.size_chart || null,
      pairs: p.pairs || [],
      ...(p.department ? { department: p.department, shipping_note: p.shipping_note || null } : {}),
      ...(p.collection === 'Logo' ? { draft: !!p.draft, logo: p.logo, model: p.model || null } : {}),
      variants: p.variants.map(v => ({ sku: v.sku, title: v.title, price_cents: v.price_cents, available: v.active !== false }))
    }))
  };
}

// Big catalogs are served a page at a time. A brand opts in with config.catalog.page_size
// and a departments.json next to its catalog. Small brands keep getting the whole catalog.
export function isPaged(brand) {
  return !!loadStore(brand).config.catalog?.page_size;
}

export function pagedCatalog(brand, { dept, q, page, skus } = {}) {
  const { config, departments } = loadStore(brand);
  const full = publicCatalog(brand);
  const size = config.catalog.page_size;
  const counts = new Map();
  for (const p of full.products) counts.set(p.department, (counts.get(p.department) || 0) + 1);
  const store = {
    ...full.store,
    skin: config.skin || null,
    paged: true,
    shipping_note: config.shipping?.note || null,
    total: full.products.length,
    departments: (departments?.departments || []).map(d => ({ id: d.id, name: d.name, group: d.group || '', count: counts.get(d.id) || 0 })).filter(d => d.count),
  };
  if (skus) {
    const want = new Set(skus);
    return { store, products: full.products.filter(p => p.variants.some(v => want.has(v.sku))) };
  }
  let list = full.products;
  if (dept) list = list.filter(p => p.department === dept);
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length) list = list.filter(p => { const t = p.title.toLowerCase(); return words.every(w => t.includes(w)); });
  const pages = Math.max(1, Math.ceil(list.length / size));
  const n = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
  // Cards only need the first photo and a short blurb.
  const products = list.slice((n - 1) * size, n * size).map(p => ({ ...p, description: '', images: p.images.slice(0, 1) }));
  return { store, products, page: n, pages, matches: list.length };
}
