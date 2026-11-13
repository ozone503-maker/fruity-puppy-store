// Wrapped so its names (BASE, params...) cannot collide with a page's own inline script.
(() => {
const BASE = location.pathname.startsWith('/store') ? '/store' : '';
const params = new URLSearchParams(location.search);
function brandFromHost() {
  const h = location.hostname;
  if (h.includes('brobots')) return 'brobots';
  if (h.includes('kudoken')) return 'kudoken';
  return '';
}
const BRAND = params.get('brand') || brandFromHost();
const brandQ = BRAND ? '?brand=' + BRAND : '';
const CART_KEY = 'store-cart-' + (BRAND || 'default');
let catalog = null;
if (!BRAND) document.body.classList.add('fp');

// Shop and Back to shop links go to the store root (/store on fruitypuppy.com), not the site homepage.
document.querySelectorAll('a[data-shop-home]').forEach(a => { a.href = (BASE || '/') + brandQ; });

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  render();
}
function money(cents) { return '$' + (cents / 100).toFixed(2); }
function findVariant(sku) {
  if (!catalog) return null;
  for (const p of [...catalog.products, ...(window.__pageProducts || [])]) {
    const v = p.variants.find(x => x.sku === sku);
    if (v) return { product: p, variant: v };
  }
  return null;
}
function suggestions() {
  if (!catalog) return [];
  const cart = getCart();
  const inCart = new Set(cart.map(i => i.sku));
  const want = new Set();
  for (const item of cart) {
    const hit = findVariant(item.sku);
    (hit?.product.pairs || []).forEach(id => want.add(id));
  }
  const out = [];
  for (const id of want) {
    const p = catalog.products.find(x => x.id === id);
    if (!p) continue;
    const v = p.variants[0];
    if (!v || v.available === false || inCart.has(v.sku)) continue;
    out.push(p);
  }
  if (!out.length) {
    for (const p of catalog.products) {
      const v = p.variants[0];
      if (v && v.available !== false && !inCart.has(v.sku)) out.push(p);
      if (out.length >= 3) break;
    }
  }
  return out.slice(0, 3);
}

function ensureDrawer() {
  if (document.getElementById('cart-drawer')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <a id="cart-badge" href="${BASE}/cart${brandQ}">Cart (0)</a>
    <div id="cart-drawer" hidden>
      <div class="cart-head"><strong>Your cart</strong><button id="cart-close" type="button">Close</button></div>
      <div id="cart-lines"></div>
      <div id="cart-suggest"></div>
      <div class="cart-foot">
        <div id="cart-sub">Subtotal $0.00</div>
        <button id="cart-checkout" type="button">Checkout</button>
        <a href="${BASE}/cart${brandQ}">View cart</a>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('cart-badge').addEventListener('click', e => {
    if (location.pathname.endsWith('/cart') || location.pathname.endsWith('/cart/')) return;
    e.preventDefault();
    document.getElementById('cart-drawer').hidden = false;
  });
  document.getElementById('cart-close').addEventListener('click', () => {
    document.getElementById('cart-drawer').hidden = true;
  });
  document.getElementById('cart-checkout').addEventListener('click', checkout);
}

function render() {
  ensureDrawer();
  const name = catalog?.store?.name;
  if (name) {
    document.title = name + ' · Cart';
    document.querySelectorAll('.fp-logo').forEach(el => { el.textContent = name; });
  }
  const cart = getCart();
  const count = cart.reduce((s, i) => s + (i.quantity || 1), 0);
  document.getElementById('cart-badge').textContent = `Cart (${count})`;
  const lines = document.getElementById('cart-lines');
  const page = document.getElementById('cart-page');
  let sub = 0;
  const html = cart.map((item, i) => {
    const hit = findVariant(item.sku);
    const title = hit ? `${hit.product.title}, ${hit.variant.title}` : item.sku;
    const gone = !hit || hit.variant.available === false;
    const price = hit ? hit.variant.price_cents : 0;
    if (hit && hit.variant.available !== false) sub += price * (item.quantity || 1);
    return `<div class="cart-line">
      <div><b>${title}</b><div>${gone ? '<span class="stock-out">Out of stock, please remove</span>' : money(price)}</div></div>
      <div class="qty">
        <button type="button" data-qty="${i}" data-d="-1">−</button>
        <span>${item.quantity || 1}</span>
        <button type="button" data-qty="${i}" data-d="1">+</button>
        <button type="button" data-remove="${i}">Remove</button>
      </div>
    </div>`;
  }).join('') || '<p>Your cart is empty.</p>';
  lines.innerHTML = html;
  if (page) page.innerHTML = html;
  const subEl = document.getElementById('cart-sub');
  if (subEl) subEl.textContent = 'Subtotal ' + money(sub);
  const pageSub = document.getElementById('cart-page-sub');
  if (pageSub) pageSub.textContent = 'Subtotal ' + money(sub);
  const sug = document.getElementById('cart-suggest');
  const pageSug = document.getElementById('cart-page-suggest');
  const sugHtml = suggestions().map(p => {
    const v = p.variants[0];
    return `<div class="suggest"><b>${p.title}</b> <span>${money(v.price_cents)}</span> <button type="button" data-add-sku="${v.sku}">Add</button></div>`;
  }).join('');
  const block = sugHtml ? `<p class="suggest-label">Suggested</p>${sugHtml}` : '';
  if (sug) sug.innerHTML = block;
  if (pageSug) pageSug.innerHTML = block;
}

// Big stores send one page at a time, so look up anything the cart needs by SKU.
async function ensureSkus(skus) {
  if (!catalog?.store?.paged) return;
  const missing = skus.filter(s => s && !findVariant(s));
  if (!missing.length) return;
  try {
    const more = await fetch(BASE + '/api/catalog' + brandQ + (brandQ ? '&' : '?') + 'skus=' + encodeURIComponent(missing.join(','))).then(r => r.json());
    const have = new Set(catalog.products.map(p => p.id));
    for (const p of more.products || []) if (!have.has(p.id)) catalog.products.push(p);
  } catch {}
}

async function addToCart(sku, quantity = 1) {
  await ensureSkus([sku]);
  const hit = findVariant(sku);
  if (hit && hit.variant.available === false) return;
  const cart = getCart();
  const existing = cart.find(i => i.sku === sku);
  if (existing) existing.quantity += quantity;
  else cart.push({ sku, quantity });
  saveCart(cart);
  const drawer = document.getElementById('cart-drawer');
  if (drawer) drawer.hidden = false;
}
function setQty(index, delta) {
  const cart = getCart();
  if (!cart[index]) return;
  cart[index].quantity = (cart[index].quantity || 1) + delta;
  if (cart[index].quantity < 1) cart.splice(index, 1);
  saveCart(cart);
}
async function checkout() {
  const cart = getCart();
  if (!cart.length) return alert('Cart empty');
  const res = await fetch(BASE + '/api/checkout' + brandQ, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: cart,
      success_url: location.origin + BASE + '/confirmation' + brandQ + (brandQ ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}',
      cancel_url: location.origin + BASE + '/cart' + brandQ,
    }),
  });
  const data = await res.json();
  if (data.url) location.href = data.url;
  else alert(data.error || 'Checkout failed');
}

document.addEventListener('click', e => {
  const add = e.target.closest('[data-add-sku]');
  if (add) { e.preventDefault(); addToCart(add.dataset.addSku); return; }
  const qty = e.target.closest('[data-qty]');
  if (qty) { setQty(Number(qty.dataset.qty), Number(qty.dataset.d)); return; }
  const rm = e.target.closest('[data-remove]');
  if (rm) { const cart = getCart(); cart.splice(Number(rm.dataset.remove), 1); saveCart(cart); }
  if (e.target.id === 'cart-page-checkout') checkout();
});

fetch(BASE + '/api/catalog' + brandQ).then(r => r.json()).then(async data => {
  catalog = data;
  if (data.store?.skin) document.body.classList.add(data.store.skin);
  await ensureSkus(getCart().map(i => i.sku));
  render();
}).catch(() => render());
render();
})();
