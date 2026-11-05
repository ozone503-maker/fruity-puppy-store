import { loadStore } from '../lib/store.js';
import { rateLimit } from '../lib/rate.js';

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
}

export function GET(request) {
  const limited = rateLimit(request, { limit: 60 });
  if (limited) return limited;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).pop();
  const brand = url.searchParams.get('brand') || undefined;
  if (!id) return new Response('Missing product id', { status: 400 });

  const { catalog, config } = loadStore(brand);
  const product = catalog.products.find((p) => p.id === id);
  if (!product) return new Response('Product not found', { status: 404 });

  const variants = product.variants || [];
  const first = variants[0] || {};
  const price = first.price_cents ? `$${(first.price_cents / 100).toFixed(2)}` : '$5 shipping';
  const images = (product.images || []).map((src) => `<img src="${esc(src)}" alt="${esc(product.title)}">`).join('');
  const options = variants.map((v) => `<option value="${esc(v.sku)}">${esc(v.title)} — $${(v.price_cents / 100).toFixed(2)}</option>`).join('');

  const chart = product.size_chart;
  const chartHtml = chart && chart.rows && chart.rows.length
    ? `<section class="size-chart"><h2>${esc(chart.title || 'Size chart')}</h2><p class="muted">${esc(chart.note || '')}</p><table><thead><tr>${chart.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${chart.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`
    : '';

  const suggested = (product.pairs || [])
    .map((pid) => catalog.products.find((p) => p.id === pid))
    .filter(Boolean)
    .slice(0, 3);
  const suggestHtml = suggested.length
    ? `<section class="suggest-block"><h2>Suggested</h2><div class="grid">${suggested.map((p) => {
        const v = p.variants[0] || {};
        const pPrice = v.price_cents ? `$${(v.price_cents / 100).toFixed(2)}` : '';
        return `<div class="card"><h3><a class="prod-link" data-id="${esc(p.id)}" href="#">${esc(p.title)}</a></h3><p class="price">${pPrice}</p><button class="add" data-add-sku="${esc(v.sku || '')}">Add to cart</button></div>`;
      }).join('')}</div></section>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(product.title)} · ${esc(config.name || 'Shop')}</title>
<meta name="description" content="${esc((product.description || '').slice(0, 160))}">
<link id="css" rel="stylesheet" href="/store.css">
</head>
<body>
<header class="fp-head">
  <a class="fp-logo" id="home" href="/">${esc(config.name || 'Shop')}</a>
  <nav><a id="shop" href="/">Shop</a> <a id="cart-link" href="/cart">Cart</a></nav>
</header>
<main class="product">
  <div class="images">${images || '<p>No photos yet</p>'}</div>
  <div class="info">
    <h1>${esc(product.title)}</h1>
    <p class="desc">${esc(product.description || '')}</p>
    <p class="price">${price}</p>
    ${options ? `<label>Color <select id="sku">${options}</select></label>` : ''}
    <button class="add" data-add-sku="${esc(first.sku || '')}">Add to cart</button>
    ${chartHtml}
  </div>
</main>
${suggestHtml}
<footer class="fp-foot"><a id="back" href="/">Back to shop</a></footer>
<script>
const BASE = location.pathname.startsWith('/store') ? '/store' : '';
const brand = new URLSearchParams(location.search).get('brand') || (location.hostname.includes('kudoken') ? 'kudoken' : location.hostname.includes('brobots') ? 'brobots' : '');
const brandQ = brand ? '?brand=' + brand : '';
document.getElementById('css').href = BASE + '/store.css';
document.getElementById('home').href = BASE + '/' + brandQ;
document.getElementById('shop').href = BASE + '/' + brandQ;
document.getElementById('cart-link').href = BASE + '/cart' + brandQ;
document.getElementById('back').href = BASE + '/' + brandQ;
document.querySelectorAll('.prod-link').forEach(a => a.href = BASE + '/product/' + a.dataset.id + brandQ);
const sel = document.getElementById('sku');
const btn = document.querySelector('.add');
if (sel && btn) sel.addEventListener('change', () => btn.dataset.addSku = sel.value);
const s = document.createElement('script');
s.src = BASE + '/cart.js';
document.body.appendChild(s);
</script>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } });
}
