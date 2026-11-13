#!/usr/bin/env node
// Fill a brand catalog from CJ Dropshipping.
//
//   CJ_API_KEY=... node tools/cj-import.js --brand brobots-tech
//   node tools/cj-import.js --brand brobots-tech --dept survival-water --limit 10
//   node tools/cj-import.js --brand brobots-tech --fresh        (rebuild instead of adding)
//
// Reads store/brands/<brand>/departments.json, searches CJ for each department,
// pulls real variants, stock and freight, prices them, and writes catalog.json.
// Nothing is invented: a product with no stock, no price or no carrier is skipped.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CJClient, cheapestFreight } from '../lib/cj.js';

const COUNTRY_NAME = { US: 'the US', CN: 'China', DE: 'Germany', GB: 'the UK', AU: 'Australia', FR: 'France', CA: 'Canada' };

// Retail price: landed cost (product + freight) times the multiplier, rounded UP to the next .99.
export function retailCents(costUsd, freightUsd, multiplier) {
  const cents = Math.round((Number(costUsd) + Number(freightUsd)) * multiplier * 100);
  return Math.max(Math.ceil((cents - 99) / 100), 0) * 100 + 99;
}

export function plainText(html, max = 600) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<\/(p|div|li|br|h\d|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/?(b|i|u|em|strong|span|a|font|small|sub|sup)(\s[^>]*)?>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), max - 80) + 1).trim();
}

export function slug(s, max = 60) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

function imageList(detail) {
  let set = detail.productImageSet;
  if (typeof set === 'string') { try { set = JSON.parse(set); } catch { set = [set]; } }
  const all = [detail.bigImage, ...(Array.isArray(set) ? set : [])].filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
  return [...new Set(all)].slice(0, 5);
}

// Which preferred warehouse country actually holds this variant.
export function stockCountry(variant, shipFrom) {
  for (const c of shipFrom) {
    const inv = (variant.inventories || []).find(i => i.countryCode === c);
    if (inv && Number(inv.totalInventory) > 0) return c;
  }
  return null;
}

// Turn one CJ product detail into a catalog product, or null with a reason.
export async function buildProduct(detail, dept, plan, client) {
  const shipFrom = plan.ship_from || ['US'];
  const maxVariants = plan.max_variants || 12;
  const stocked = [];
  for (const v of detail.variants || []) {
    const country = stockCountry(v, shipFrom);
    const cost = Number(v.variantSellPrice);
    if (!country || !v.vid || !v.variantSku || !(cost > 0)) continue;
    stocked.push({ v, country, cost });
  }
  if (!stocked.length) return { skip: 'no stock in ' + shipFrom.join('/') };

  // One origin per product keeps the delivery promise on the page true.
  const origin = shipFrom.find(c => stocked.some(s => s.country === c));
  const usable = stocked.filter(s => s.country === origin).slice(0, maxVariants);

  const freight = cheapestFreight(await client.freight({ from: origin, to: plan.ship_to || 'US', items: [{ vid: usable[0].v.vid, quantity: 1 }] }));
  if (!freight) return { skip: 'no carrier to ' + (plan.ship_to || 'US') };

  const price = plan.pricing || {};
  const multiplier = price.multiplier || 1.2;
  const maxRetail = price.max_retail_cents || Infinity;
  const variants = usable.map(({ v, cost }) => ({
    sku: v.variantSku,
    title: v.variantKey || v.variantNameEn || 'Standard',
    price_cents: retailCents(cost, freight.price, multiplier),
    active: true,
    cj_vid: v.vid,
    cj_cost_cents: Math.round(cost * 100),
  })).filter(v => v.price_cents <= maxRetail);
  if (!variants.length) return { skip: 'over max price' };

  const title = String(detail.productNameEn || '').trim();
  if (!title) return { skip: 'no title' };
  const images = imageList(detail);
  if (!images.length) return { skip: 'no photos' };

  return {
    product: {
      id: `${slug(title, 48)}-${String(detail.pid).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`,
      title,
      brand: plan.brand_label || 'Brobots',
      type: dept.name,
      collection: dept.name,
      department: dept.id,
      description: plainText(detail.description),
      images,
      tags: ['cj', dept.group ? slug(dept.group) : null, dept.id].filter(Boolean),
      fulfiller: 'cj',
      cj_pid: detail.pid,
      cj_sku: detail.productSku || null,
      ships_from: origin,
      cj_logistic: freight.name,
      cj_freight_cents: Math.round(freight.price * 100),
      delivery_days: freight.aging || null,
      shipping_note: `Ships from ${COUNTRY_NAME[origin] || origin}${freight.aging ? `, about ${freight.aging} days` : ''}. Shipping included.`,
      imported_at: new Date().toISOString().slice(0, 10),
      variants,
    },
  };
}

export async function runImport({ client, plan, catalog, only, limit, log = console.log, save = () => {} }) {
  const shipFrom = plan.ship_from || ['US'];
  const perDept = limit || plan.per_department || 40;
  const have = new Set(catalog.products.map(p => p.cj_pid).filter(Boolean));
  const ids = new Set(catalog.products.map(p => p.id));
  const skus = new Set(catalog.products.flatMap(p => p.variants.map(v => v.sku)));
  const stats = { added: 0, skipped: 0, failed: 0, departments: 0, reasons: {} };
  const skip = why => { stats.skipped++; stats.reasons[why] = (stats.reasons[why] || 0) + 1; };

  for (const dept of plan.departments) {
    if (only && dept.id !== only) continue;
    stats.departments++;
    let count = catalog.products.filter(p => p.department === dept.id).length;
    log(`\n[${dept.id}] ${dept.name}: have ${count}, want ${perDept}`);
    const seen = new Set();
    for (const keyWord of dept.keywords) {
      if (count >= perDept) break;
      for (const countryCode of shipFrom) {
        if (count >= perDept) break;
        let found;
        try {
          found = await client.search({ keyWord, countryCode, size: Math.min(50, Math.max(10, (perDept - count) * 2)) });
        } catch (err) { log(`  search "${keyWord}" ${countryCode} failed: ${err.message}`); stats.failed++; continue; }
        for (const hit of found.products) {
          if (count >= perDept) break;
          const pid = hit.id || hit.pid;
          if (!pid || seen.has(pid) || have.has(pid)) continue;
          seen.add(pid);
          try {
            const detail = await client.product(pid);
            const built = await buildProduct(detail, dept, plan, client);
            if (built.skip) { skip(built.skip); continue; }
            const p = built.product;
            if (ids.has(p.id)) { skip('duplicate'); continue; }
            p.variants = p.variants.filter(v => !skus.has(v.sku));
            if (!p.variants.length) { skip('duplicate'); continue; }
            catalog.products.push(p);
            have.add(pid); ids.add(p.id); p.variants.forEach(v => skus.add(v.sku));
            count++; stats.added++;
            log(`  + ${p.title.slice(0, 70)}  $${(p.variants[0].price_cents / 100).toFixed(2)}  (${p.ships_from})`);
            if (stats.added % 10 === 0) save(catalog);
          } catch (err) { log(`  product ${pid} failed: ${err.message}`); stats.failed++; }
        }
      }
    }
    save(catalog);
  }
  return stats;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? (process.argv[i + 1] ?? true) : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const brand = arg('--brand');
  if (!brand) { console.error('Usage: node tools/cj-import.js --brand <brand> [--dept id] [--limit n] [--fresh]'); process.exit(1); }
  const dir = join(fileURLToPath(new URL('../store/brands/', import.meta.url)), brand);
  const plan = JSON.parse(readFileSync(join(dir, 'departments.json'), 'utf8'));
  const file = join(dir, 'catalog.json');
  const catalog = process.argv.includes('--fresh') ? { products: [] } : JSON.parse(readFileSync(file, 'utf8'));
  const save = c => writeFileSync(file, JSON.stringify(c, null, 1) + '\n');
  const client = new CJClient();
  const limit = Number(arg('--limit', 0)) || undefined;
  const stats = await runImport({ client, plan, catalog, only: arg('--dept'), limit, save });
  save(catalog);
  if (stats.skipped) console.log('\nSkipped because:', JSON.stringify(stats.reasons));
  console.log(`\nDone. Added ${stats.added}, skipped ${stats.skipped}, failed ${stats.failed}. Catalog now has ${catalog.products.length} products. CJ calls used: ${client.calls}.`);
}
