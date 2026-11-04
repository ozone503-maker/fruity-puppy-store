import { loadStore } from '../lib/store.js';
import { rateLimit } from '../lib/rate.js';

export function GET(request) {
  const limited = rateLimit(request, { limit: 60 });
  if (limited) return limited;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).pop();
  if (!id) return new Response('Missing product id', { status: 400 });

  const { catalog, config } = loadStore();
  const product = catalog.products.find((p) => p.id === id);
  if (!product) return new Response('Product not found', { status: 404 });

  const variants = product.variants || [];
  const first = variants[0] || {};
  const price = first.price_cents ? `$${(first.price_cents / 100).toFixed(2)}` : '';
  const images = (product.images || []).map((src) => `<img src="${src}" alt="${product.title}">`).join('');
  const options = variants.map((v) => `<option value="${v.sku}">${v.title} — $${(v.price_cents / 100).toFixed(2)}</option>`).join('');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${product.title} · ${config.name || 'Shop'}</title>
<meta name="description" content="${(product.description || '').slice(0, 160)}">
<link rel="stylesheet" href="/store.css">
</head>
<body>
<header class="fp-head">
  <a class="fp-logo" href="/">${config.name || 'Shop'}</a>
  <nav><a href="/">Shop</a></nav>
</header>
<main class="product">
  <div class="images">${images || '<p>No photos yet</p>'}</div>
  <div class="info">
    <h1>${product.title}</h1>
    <p>${product.description || ''}</p>
    <p class="price">${price}</p>
    ${options ? `<label>Option <select id="sku">${options}</select></label>` : ''}
    <button class="add" data-add-sku="${first.sku || ''}">Add to cart</button>
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

  return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } });
}
