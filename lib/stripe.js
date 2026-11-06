import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

// Verifies a Stripe-Signature header (v1 HMAC-SHA256) over the raw body.
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const parts = Object.create(null);
  const v1 = [];
  for (const piece of header.split(',')) {
    const [k, v] = piece.split('=');
    if (k === 'v1') v1.push(v || ''); else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !v1.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return v1.some(sig => {
    const b = Buffer.from(sig);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

export async function stripeGet(path, key, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe GET ${path.split('?')[0]} ${res.status}`);
  return body;
}
