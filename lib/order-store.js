// Durable order storage. Uses an Upstash Redis REST endpoint when configured
// (KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN).
// No silent in-memory fallback in production: getOrderStore() returns null when unconfigured,
// and callers fail with 503 so Stripe retries the webhook instead of the order being lost.

export function memoryStore() {
  const kv = new Map();
  const queue = [];
  return {
    kind: 'memory',
    async claimEvent(id) { const k = `evt:${id}`; if (kv.has(k)) return false; kv.set(k, '1'); return true; },
    async releaseEvent(id) { kv.delete(`evt:${id}`); },
    async getOrder(id) { const v = kv.get(`order:${id}`); return v ? JSON.parse(v) : null; },
    async putOrder(order) {
      const isNew = !kv.has(`order:${order.id}`);
      kv.set(`order:${order.id}`, JSON.stringify(order));
      if (isNew) queue.push(order.id);
    },
    async listOrderIds(limit = 50) { return queue.slice(-limit).reverse(); },
  };
}

export function upstashStore({ url, token, prefix = 'fps:', fetchImpl = fetch }) {
  // Prefix isolates this store's keys; the Redis database may be shared with other projects.
  const k = key => `${prefix}${key}`;
  async function cmd(args) {
    const res = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Order store ${args[0]} failed (${res.status})`);
    return body.result;
  }
  return {
    kind: 'upstash',
    async claimEvent(id) { return (await cmd(['SET', k(`evt:${id}`), '1', 'NX', 'EX', String(60 * 60 * 24 * 30)])) === 'OK'; },
    async releaseEvent(id) { await cmd(['DEL', k(`evt:${id}`)]); },
    async getOrder(id) { const v = await cmd(['GET', k(`order:${id}`)]); return v ? JSON.parse(v) : null; },
    async putOrder(order) {
      const created = await cmd(['SET', k(`order:${order.id}`), JSON.stringify(order)]);
      await cmd(['ZADD', k('orders'), 'NX', String(order.created_at_ms || Date.now()), order.id]);
      return created;
    },
    async listOrderIds(limit = 50) { return cmd(['ZRANGE', k('orders'), '0', String(limit - 1), 'REV']); },
  };
}

let override;
export function setOrderStore(store) { override = store; }

export function getOrderStore(env = process.env) {
  if (override !== undefined) return override;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore({ url, token });
  return null;
}
