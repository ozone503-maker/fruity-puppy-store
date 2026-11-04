import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}

/**
 * Verify a Stripe webhook `Stripe-Signature` header (t=...,v1=...).
 * Signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret.
 */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET not set' };
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' };
  let t; const v1 = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) return { ok: false, reason: 'malformed Stripe-Signature header' };
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return v1.some((sig) => safeEqualHex(sig, expected)) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** Sign a payload the way Stripe does (used by tests and local tooling). */
export function signStripePayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

/**
 * Verify a Printify webhook `X-Pfy-Signature: sha256={hex}` header:
 * HMAC-SHA256 hexdigest of the raw body with the secret set on the webhook.
 */
export function verifyPrintifySignature(rawBody, header, secret) {
  if (!secret) return { ok: false, reason: 'PRINTIFY_WEBHOOK_SECRET not set' };
  if (!header) return { ok: false, reason: 'missing X-Pfy-Signature header' };
  const m = /^sha256=([0-9a-f]+)$/i.exec(String(header).trim());
  if (!m) return { ok: false, reason: 'malformed X-Pfy-Signature header' };
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqualHex(m[1].toLowerCase(), expected) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

export function signPrintifyPayload(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}
