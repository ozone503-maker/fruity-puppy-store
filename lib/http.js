export function corsHeaders() { return {}; }
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// Constant-time bearer check against an env secret. Fails closed when the secret is unset.
import { timingSafeEqual } from 'node:crypto';
export function requireBearer(request, envName) {
  const secret = process.env[envName];
  if (!secret) return json({ error: 'Not configured' }, 503);
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'Unauthorized' }, 401);
  return null;
}
