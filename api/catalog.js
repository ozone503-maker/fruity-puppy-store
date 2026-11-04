import { publicCatalog } from '../lib/commerce.js';
import { corsHeaders, json } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

export function OPTIONS(request) { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
export function GET(request) {
  const limited = rateLimit(request, { limit: 120 });
  if (limited) return limited;
  const brand = new URL(request.url).searchParams.get('brand') || undefined;
  return json(publicCatalog(brand), 200, corsHeaders(request));
}
