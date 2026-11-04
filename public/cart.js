// Minimal cart for store kit
const CART_KEY = 'fp-cart';

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartUI();
}
function updateCartUI() {
  const count = getCart().reduce((s, i) => s + (i.quantity || 1), 0);
  let badge = document.getElementById('cart-badge');
  if (!badge) {
    badge = document.createElement('a');
    badge.id = 'cart-badge';
    badge.href = '#';
    badge.style.cssText = 'position:fixed;top:1rem;right:1rem;background:#c45c4a;color:#fff;padding:.4rem .8rem;border-radius:2rem;text-decoration:none;z-index:10';
    document.body.appendChild(badge);
    badge.addEventListener('click', e => { e.preventDefault(); checkout(); });
  }
  badge.textContent = `Cart (${count})`;
}
function addToCart(sku, quantity = 1) {
  const cart = getCart();
  const existing = cart.find(i => i.sku === sku);
  if (existing) existing.quantity += quantity;
  else cart.push({ sku, quantity });
  saveCart(cart);
}
async function checkout() {
  const cart = getCart();
  if (!cart.length) return alert('Cart empty');
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: cart, success_url: location.origin + '?success=1', cancel_url: location.href }),
  });
  const data = await res.json();
  if (data.url) location.href = data.url;
  else alert(data.error || 'Checkout failed');
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-add-sku]');
  if (btn) {
    e.preventDefault();
    addToCart(btn.dataset.addSku);
  }
});
updateCartUI();
