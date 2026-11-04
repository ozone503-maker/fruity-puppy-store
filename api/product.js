import { loadStore } from '../lib/store.js';
import { rateLimit } from '../lib/rate.js';

// Escape catalog text before putting it in HTML. Catalog entries can now come from
// Printify (merch factory), so titles/descriptions/image URLs are treated as untrusted.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https:\/\//i.test(String(u || '')) || String(u || '').startsWith('/') ? esc(u) : '');

export function GET(request) {
  const limited = rateLimit(request, { limit: 60 });
  if (limited) return limited;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).pop();
  if (!id) return new Response('Missing product id', { status: 400 });

  const { catalog, config } = loadStore();
  const product = catalog.products.find((p) => p.id === id);
  if (!product) return new Response('Product not found', { status: 404 });

  const variants = (product.variants || []).filter((v) => v.active !== false);
  const first = variants[0] || {};
  const price = first.price_cents ? `$${(first.price_cents / 100).toFixed(2)}` : '';
  const images = (product.images || []).map(safeUrl).filter(Boolean)
    .map((src) => `<img src="${src}" alt="${esc(product.title)}" loading="lazy">`).join('');
  const options = variants.map((v) => `<option value="${esc(v.sku)}">${esc(v.title)} — $${(v.price_cents / 100).toFixed(2)}</option>`).join('');
  const shopName = esc(config.name || 'Shop');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(product.title)} · ${shopName}</title>
<meta name="description" content="${esc((product.description || '').slice(0, 160))}">
<link rel="stylesheet" href="/store.css">
</head>
<body>
<header class="fp-head">
  <a class="fp-logo" href="/">${shopName}</a>
  <nav><a href="/">Shop</a></nav>
</header>
<main class="product">
  <div class="images">${images || '<p>No photos yet</p>'}</div>
  <div class="info">
    <h1>${esc(product.title)}</h1>
    <p>${esc(product.description)}</p>
    <p class="price">${price}</p>
    ${options ? `<label>Option <select id="sku">${options}</select></label>` : ''}
    ${first.sku ? `<button class="add" data-add-sku="${esc(first.sku)}">Add to cart</button>` : '<p>Currently unavailable</p>'}
  </div>
</main>
<footer class="fp-foot"><a href="/">Back to shop</a></footer>
<script>
const sel = document.getElementById('sku');
const btn = document.querySelector('.add');
if (sel && btn) sel.addEventListener('change', () => btn.dataset.addSku = sel.value);
</script>
<script src="/cart.js" defer></script>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}
