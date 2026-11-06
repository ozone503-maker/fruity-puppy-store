// Branded order confirmation emails (separate from Stripe's own payment receipts).
// Outbox lives on the order record: order.confirmation_email = { status, attempts, ... }.
// status: pending (queued, sending disabled or not yet attempted) | sent | failed
// Sending is OFF unless ORDER_EMAILS_ENABLED=true AND a provider key + verified sender are set.
// Provider: Resend HTTP API (Idempotency-Key = order id, so retries never double-send).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'usd') => cents == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);

export function emailConfig(env = process.env) {
  return {
    enabled: env.ORDER_EMAILS_ENABLED === 'true',
    apiKey: env.RESEND_API_KEY || '',
    from: env.ORDER_EMAIL_FROM || '',
    replyTo: env.ORDER_EMAIL_REPLY_TO || '',
  };
}
export function canSend(cfg) { return cfg.enabled && !!cfg.apiKey && !!cfg.from; }

export function renderConfirmation(order, storeName = 'Fruity Puppy') {
  const cur = order.currency || 'usd';
  const rows = order.items.map(i => `<tr><td>${esc(i.title)}</td><td align="center">${esc(i.quantity)}</td><td align="right">${esc(money(i.amount_total_cents, cur))}</td></tr>`).join('');
  const text = [
    `Thanks for your order from ${storeName}.`,
    `Order: ${order.id.slice(0, 18)}`,
    ...order.items.map(i => `${i.quantity} x ${i.title}  ${money(i.amount_total_cents, cur)}`),
    order.amount_shipping_cents != null ? `Shipping: ${money(order.amount_shipping_cents, cur)}` : '',
    `Total paid: ${money(order.amount_total_cents, cur)}`,
    'We will email you again when it ships.',
  ].filter(Boolean).join('\n');
  const html = `<p>Thanks for your order from ${esc(storeName)}.</p><p>Order: ${esc(order.id.slice(0, 18))}</p>
<table cellpadding="4">${rows}</table>
${order.amount_shipping_cents != null ? `<p>Shipping: ${esc(money(order.amount_shipping_cents, cur))}</p>` : ''}
<p><strong>Total paid: ${esc(money(order.amount_total_cents, cur))}</strong></p><p>We will email you again when it ships.</p>`;
  return { subject: `Your ${storeName} order is confirmed`, text, html };
}

// Queue a confirmation only for verified paid orders with an email; never twice.
export function queueConfirmation(order) {
  if (order.payment !== 'paid' || !order.email || order.confirmation_email) return false;
  order.confirmation_email = { status: 'pending', attempts: 0, queued_at: new Date().toISOString() };
  return true;
}

export async function dispatchConfirmation(order, store, { cfg = emailConfig(), fetchImpl = fetch, storeName } = {}) {
  const ce = order.confirmation_email;
  if (!ce || ce.status === 'sent' || order.payment !== 'paid') return { skipped: true };
  if (!canSend(cfg)) return { skipped: true, reason: 'sending_disabled' };
  const msg = renderConfirmation(order, storeName);
  ce.attempts += 1;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `order-confirmation/${order.id}` },
      body: JSON.stringify({ from: cfg.from, to: [order.email], subject: msg.subject, text: msg.text, html: msg.html, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`provider ${res.status}`);
    Object.assign(ce, { status: 'sent', sent_at: new Date().toISOString(), provider_id: body.id || null, last_error: null });
  } catch (err) {
    Object.assign(ce, { status: 'failed', last_error: String(err.message).slice(0, 120) });
  }
  await store.putOrder(order);
  return { status: ce.status };
}
