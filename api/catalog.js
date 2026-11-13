import { publicCatalog, isPaged, pagedCatalog } from '../lib/commerce.js';
import { corsHeaders, json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

export function OPTIONS(request) { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
export function GET(request) {
  const limited = rateLimit(request, { limit: 120 });
  if (limited) return limited;
  const q = new URL(request.url).searchParams;
  const brand = q.get('brand') || undefined;
  let paged;
  try { paged = isPaged(brand); } catch { return json({ error: 'Unknown store' }, 400); }
  if (paged) {
    const skus = q.get('skus') ? q.get('skus').split(',').slice(0, 60) : null;
    return json(pagedCatalog(brand, { dept: q.get('dept'), q: q.get('q'), page: q.get('page'), skus }), 200, corsHeaders(request));
  }
  return json(publicCatalog(brand), 200, corsHeaders(request));
}
