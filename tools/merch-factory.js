#!/usr/bin/env node
// Merch factory: Printify blueprint -> provider -> variants -> priced product -> catalog.json
//
// Usage (see store/OPERATOR.md for the full walkthrough):
//   node tools/merch-factory.js --dry-run --blueprint 6 --provider 3 --colors "Solid Black" --sizes S,M,L --title "Fruity Puppy Tee"
//   node tools/merch-factory.js --list-blueprints --search tee
//   node tools/merch-factory.js --list-providers --blueprint 6
//   node tools/merch-factory.js --blueprint 6 --provider 3 --colors "Solid Black" --sizes S,M,L \
//       --image https://example.com/design.png --title "Fruity Puppy Tee" --create
//
// Modes:
//   --dry-run   No writes to Printify. Works without a token (uses tools/fixtures/printify-sample.json);
//               with a token it reads the live catalog. Writes catalog only if --catalog <path> is given.
//   (default)   Live, read-only preview of the plan. Requires PRINTIFY_API_TOKEN + PRINTIFY_SHOP_ID.
//   --create    Uploads the design and creates an UNPUBLISHED Printify product, prices it from Printify's
//               wholesale cost, fetches mockups, and upserts store/catalog.json. Never publishes. Never orders.
//
// Pricing: retail = wholesale cost x 1.20, rounded UP to the nearest $x.99 (all integer cents).

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrintifyClient, printifyTokenFromEnv } from '../lib/printify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = resolve(HERE, '../store/catalog.json');
const DEFAULT_FIXTURE = resolve(HERE, 'fixtures/printify-sample.json');
export const MARKUP = 1.2;

// ---------------------------------------------------------------- pure helpers

/** retail = cost * 1.20 rounded UP to the nearest .99, in integer cents. */
export function retailPriceCents(costCents, markup = MARKUP) {
  const cost = Number(costCents);
  if (!Number.isInteger(cost) || cost <= 0) throw new Error(`Invalid wholesale cost: ${costCents}`);
  // Integer math: markup expressed in basis points avoids float drift (1.2 -> 12000/10000).
  const bp = Math.round(markup * 10000);
  const min = Math.ceil((cost * bp) / 10000);
  if (min <= 99) return 99;
  return Math.ceil((min - 99) / 100) * 100 + 99;
}

export function parseArgs(argv) {
  const flags = new Set(['--dry-run', '--create', '--list-blueprints', '--list-providers', '--include-out-of-stock', '--help']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flags.has(a)) { out[key] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
    out[key] = v; i++;
  }
  return out;
}

const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const norm = (s) => String(s || '').trim().toLowerCase();

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'merch';
}

/** Filter catalog variants by color/size/id and required print position. */
export function selectVariants(variants, { colors = [], sizes = [], ids = [], position = 'front', max = 24 } = {}) {
  const c = colors.map(norm), s = sizes.map(norm), idset = new Set(ids.map(Number));
  const picked = variants.filter((v) =>
    (!idset.size || idset.has(Number(v.id)))
    && (!c.length || c.includes(norm(v.options?.color)))
    && (!s.length || s.includes(norm(v.options?.size)))
    && (v.placeholders || []).some((p) => p.position === position));
  if (!picked.length) {
    const colorsAvail = [...new Set(variants.map((v) => v.options?.color).filter(Boolean))];
    const sizesAvail = [...new Set(variants.map((v) => v.options?.size).filter(Boolean))];
    throw new Error(`No variants match. Position "${position}". Colors available: ${colorsAvail.join(', ')}. Sizes: ${sizesAvail.join(', ')}`);
  }
  if (picked.length > max) throw new Error(`${picked.length} variants match; narrow with --colors/--sizes or raise --max-variants (now ${max})`);
  return picked;
}

/** Printify create-product payload. Prices are provisional until costs are known. */
export function buildProductPayload({ title, description, tags, blueprintId, providerId, variants, imageId, position, priceFor }) {
  return {
    title,
    description,
    tags,
    blueprint_id: Number(blueprintId),
    print_provider_id: Number(providerId),
    variants: variants.map((v) => ({ id: v.id, price: priceFor(v), is_enabled: true })),
    print_areas: [{
      variant_ids: variants.map((v) => v.id),
      placeholders: [{ position, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
    }],
  };
}

/** Pick mockup URLs for the selected variants: default image first, de-duplicated. */
export function pickMockups(images = [], variantIds = [], max = 10) {
  const ids = new Set(variantIds.map(Number));
  const rel = images.filter((img) => img?.src && (!img.variant_ids || img.variant_ids.some((id) => ids.has(Number(id)))));
  rel.sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)));
  return [...new Set(rel.map((i) => i.src))].slice(0, max);
}

export function buildCatalogEntry({ id, title, description, tags, blueprintId, blueprintTitle, providerId, providerTitle,
  printifyProductId, variants, pricing, images, imagesByVariant = {}, dryRun = false }) {
  const skuBase = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
  return {
    id,
    title,
    brand: 'Fruity Puppy',
    type: 'Merch',
    collection: 'Merch',
    description,
    images,
    tags,
    fulfiller: 'printify',
    printify_product_id: printifyProductId,
    blueprint_id: Number(blueprintId),
    blueprint_title: blueprintTitle,
    print_provider_id: Number(providerId),
    print_provider_title: providerTitle,
    ...(dryRun ? { dry_run: true } : {}),
    variants: variants.map((v) => {
      const p = pricing.get(v.id);
      return {
        sku: `${skuBase}-${v.id}`,
        title: [v.options?.color, v.options?.size].filter(Boolean).join(' / ') || v.title,
        color: v.options?.color || null,
        size: v.options?.size || null,
        price_cents: p.price_cents,
        cost_cents: p.cost_cents,
        printify_product_id: printifyProductId,
        printify_variant_id: v.id,
        ...(imagesByVariant[v.id] ? { image: imagesByVariant[v.id] } : {}),
        active: !dryRun,
      };
    }),
  };
}

/** Insert or replace by printify_product_id. Keeps product ids unique. */
export function upsertCatalog(catalog, entry) {
  const products = Array.isArray(catalog?.products) ? [...catalog.products] : [];
  const idx = products.findIndex((p) => p.printify_product_id && p.printify_product_id === entry.printify_product_id);
  if (idx >= 0) {
    products[idx] = { ...entry, id: products[idx].id }; // keep the existing URL slug
    return { catalog: { ...catalog, products }, action: 'updated', id: products[idx].id };
  }
  let id = entry.id, n = 2;
  while (products.some((p) => p.id === id)) id = `${entry.id}-${n++}`;
  products.push({ ...entry, id });
  return { catalog: { ...(catalog || {}), products }, action: 'added', id };
}

export function readCatalog(path) {
  if (!existsSync(path)) return { products: [] };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data.products)) throw new Error(`${path} has no "products" array`);
  return data;
}

export function writeCatalogAtomic(path, catalog) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------- data sources

function fixtureSource(path) {
  const fx = JSON.parse(readFileSync(path, 'utf8'));
  return {
    kind: 'fixture',
    listBlueprints: async () => fx.blueprints,
    listPrintProviders: async (bp) => fx.print_providers[String(bp)] || [],
    getVariants: async (bp, pp) => {
      const v = fx.variants[`${bp}:${pp}`];
      if (!v) throw new Error(`Fixture has no variants for blueprint ${bp} / provider ${pp} (try --blueprint 6 --provider 3)`);
      return v;
    },
    costFor: (variantId) => fx.costs_cents?.[String(variantId)],
  };
}

// ---------------------------------------------------------------- main

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

export async function run(argv, { env = process.env, clientFactory } = {}) {
  const o = parseArgs(argv);
  if (o.help) { log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n').replace(/^\/\/ ?/gm, '')); return { ok: true }; }

  const dryRun = Boolean(o.dryRun);
  const create = Boolean(o.create);
  if (dryRun && create) throw new Error('--dry-run and --create are mutually exclusive');

  const token = printifyTokenFromEnv(env);
  const shopId = env.PRINTIFY_SHOP_ID;
  if (!dryRun) {
    const missing = [!token && 'PRINTIFY_API_TOKEN', !shopId && 'PRINTIFY_SHOP_ID'].filter(Boolean);
    if (missing.length) {
      const e = new Error(`Missing required env: ${missing.join(', ')}. Set them (or use --dry-run). See store/OPERATOR.md.`);
      e.exitCode = 2;
      throw e;
    }
  }

  const client = token ? (clientFactory ? clientFactory({ token, shopId }) : new PrintifyClient({ token, shopId })) : null;
  const src = client
    ? { kind: 'live', listBlueprints: () => client.listBlueprints(), listPrintProviders: (b) => client.listPrintProviders(b),
        getVariants: (b, p) => client.getVariants(b, p, { showOutOfStock: Boolean(o.includeOutOfStock) }), costFor: () => undefined }
    : fixtureSource(resolve(o.fixture || DEFAULT_FIXTURE));
  log(`[merch] mode=${dryRun ? 'dry-run' : create ? 'CREATE (unpublished)' : 'preview'} catalog-source=${src.kind}`);
  if (src.kind === 'fixture') log('[merch] No PRINTIFY_API_TOKEN: using SAMPLE fixture data. Ids/costs are illustrative only.');

  // 1. Blueprints
  const blueprints = await src.listBlueprints();
  if (o.listBlueprints) {
    const q = norm(o.search);
    const rows = blueprints.filter((b) => !q || norm(`${b.title} ${b.brand} ${b.model}`).includes(q));
    rows.slice(0, 200).forEach((b) => log(`${String(b.id).padStart(6)}  ${b.title}  (${b.brand || ''} ${b.model || ''})`.trimEnd()));
    log(`[merch] ${rows.length} blueprint(s)`);
    return { ok: true, blueprints: rows };
  }
  const blueprintId = Number(o.blueprint);
  if (!Number.isInteger(blueprintId) || blueprintId <= 0) throw new Error('--blueprint <id> is required (find one with --list-blueprints --search tee)');
  const blueprint = blueprints.find((b) => Number(b.id) === blueprintId);
  if (!blueprint) throw new Error(`Blueprint ${blueprintId} not found in catalog`);
  log(`[merch] blueprint ${blueprint.id}: ${blueprint.title} (${blueprint.brand || ''} ${blueprint.model || ''})`);

  // 2. Print providers for that blueprint
  const providers = await src.listPrintProviders(blueprintId);
  if (!providers.length) throw new Error(`No print providers for blueprint ${blueprintId}`);
  if (o.listProviders) {
    providers.forEach((p) => log(`${String(p.id).padStart(6)}  ${p.title}`));
    return { ok: true, providers };
  }
  const providerId = o.provider ? Number(o.provider) : Number(providers[0].id);
  const provider = providers.find((p) => Number(p.id) === providerId);
  if (!provider) throw new Error(`Provider ${providerId} does not fulfill blueprint ${blueprintId}. Options: ${providers.map((p) => `${p.id} ${p.title}`).join('; ')}`);
  log(`[merch] provider ${provider.id}: ${provider.title}${o.provider ? '' : ' (first listed; pass --provider to choose)'}`);

  // 3. Variants for blueprint + provider
  const variantData = await src.getVariants(blueprintId, providerId);
  const position = o.position || 'front';
  const selected = selectVariants(variantData.variants || [], {
    colors: list(o.colors), sizes: list(o.sizes), ids: list(o.variantIds), position, max: Number(o.maxVariants || 24),
  });
  log(`[merch] ${selected.length} variant(s) selected on "${position}": ${selected.map((v) => v.title).join(', ')}`);

  const title = o.title || `${blueprint.title}`;
  const description = o.description || `Fruity Puppy ${blueprint.title}.`;
  const tags = list(o.tags || 'merch,fruity puppy');
  const id = o.id ? slugify(o.id) : slugify(title);
  const catalogPath = resolve(o.catalog || DEFAULT_CATALOG);

  // 4. Pricing
  const pricing = new Map();
  const priceSelected = (costOf) => {
    for (const v of selected) {
      const cost = costOf(v.id);
      if (!Number.isInteger(cost) || cost <= 0) throw new Error(`No wholesale cost for variant ${v.id} (${v.title})`);
      pricing.set(v.id, { cost_cents: cost, price_cents: retailPriceCents(cost) });
    }
  };
  const estimate = o.costCents ? Number(o.costCents) : undefined;

  if (!create) {
    // Printify only reports wholesale cost on a created product, so previews use the fixture or --cost-cents.
    const costOf = (vid) => src.costFor(vid) ?? estimate;
    if (selected.every((v) => Number.isInteger(costOf(v.id)))) {
      priceSelected(costOf);
      for (const v of selected) {
        const p = pricing.get(v.id);
        log(`[merch]   ${v.title.padEnd(28)} cost ${fmt(p.cost_cents)} -> retail ${fmt(p.price_cents)}${src.kind === 'live' ? ' (estimate)' : ''}`);
      }
    } else {
      log('[merch] Wholesale cost is only known after the product is created in Printify; pass --cost-cents to estimate.');
    }
    const payload = buildProductPayload({ title, description, tags, blueprintId, providerId, variants: selected,
      imageId: o.imageId || '<uploaded-image-id>', position, priceFor: (v) => pricing.get(v.id)?.price_cents ?? 0 });
    log('[merch] Printify create-product payload (NOT sent):');
    log(JSON.stringify(payload, null, 2));

    if (!pricing.size) return { ok: true, payload };
    const entry = buildCatalogEntry({ id, title, description, tags, blueprintId, blueprintTitle: blueprint.title, providerId,
      providerTitle: provider.title, printifyProductId: `dry-run-${blueprintId}-${providerId}-${id}`, variants: selected, pricing,
      images: blueprint.images || [], dryRun: true });
    if (dryRun && o.catalog) {
      const res = upsertCatalog(readCatalog(catalogPath), entry);
      writeCatalogAtomic(catalogPath, res.catalog);
      log(`[merch] dry-run catalog entry ${res.action} as "${res.id}" in ${catalogPath}`);
    } else {
      log('[merch] Catalog entry that would be written (pass --catalog <path> with --dry-run to write it to a scratch file):');
      log(JSON.stringify(entry, null, 2));
    }
    return { ok: true, payload, entry };
  }

  // ---- CREATE (live, unpublished) ----
  if (!o.image && !o.imageId) throw new Error('--image <https url> or --image-id <printify upload id> is required with --create');
  let imageId = o.imageId;
  if (!imageId) {
    const u = new URL(o.image);
    if (u.protocol !== 'https:') throw new Error('--image must be an https URL');
    const fileName = (u.pathname.split('/').pop() || 'design.png').slice(0, 100);
    log(`[merch] uploading design ${fileName} ...`);
    const up = await client.uploadImage({ file_name: fileName, url: o.image });
    if (!up?.id) throw new Error('Printify upload returned no image id');
    imageId = up.id;
    log(`[merch] uploaded image id ${imageId}`);
  }

  const provisional = Number(o.provisionalPriceCents || 9999);
  const payload = buildProductPayload({ title, description, tags, blueprintId, providerId, variants: selected, imageId, position,
    priceFor: () => provisional });
  const created = await client.createProduct(payload);
  if (!created?.id) throw new Error('Printify createProduct returned no product id');
  const printifyProductId = String(created.id);
  log(`[merch] created UNPUBLISHED Printify product ${printifyProductId}`);

  // Wholesale costs come back on the product's variants.
  let product = await client.getProduct(printifyProductId);
  const costById = new Map((product.variants || []).map((v) => [Number(v.id), Number(v.cost)]));
  priceSelected((vid) => costById.get(Number(vid)));
  const selectedIds = new Set(selected.map((v) => Number(v.id)));
  await client.updateProduct(printifyProductId, {
    variants: (product.variants || []).map((v) => selectedIds.has(Number(v.id))
      ? { id: v.id, price: pricing.get(Number(v.id)).price_cents, is_enabled: true }
      : { id: v.id, price: v.price, is_enabled: false }),
  });
  for (const v of selected) {
    const p = pricing.get(v.id);
    log(`[merch]   ${v.title.padEnd(28)} cost ${fmt(p.cost_cents)} -> retail ${fmt(p.price_cents)}`);
  }

  // Mockups are generated asynchronously; poll briefly.
  const waitSec = Number(o.mockupWait || 60);
  const deadline = Date.now() + waitSec * 1000;
  let images = [];
  for (;;) {
    product = await client.getProduct(printifyProductId);
    images = pickMockups(product.images, [...selectedIds]);
    if (images.length || Date.now() >= deadline) break;
    await sleep(5000);
  }
  if (!images.length) log(`[merch] WARNING: no mockups after ${waitSec}s. Do NOT re-run --create (that makes a duplicate product); fetch images later from GET /v1/shops/{shop_id}/products/${printifyProductId}.json.`);
  const imagesByVariant = {};
  for (const v of selected) {
    const img = (product.images || []).find((i) => i.variant_ids?.map(Number).includes(Number(v.id)) && i.is_default)
      || (product.images || []).find((i) => i.variant_ids?.map(Number).includes(Number(v.id)));
    if (img?.src) imagesByVariant[v.id] = img.src;
  }

  const entry = buildCatalogEntry({ id, title, description, tags, blueprintId, blueprintTitle: blueprint.title, providerId,
    providerTitle: provider.title, printifyProductId, variants: selected, pricing, images, imagesByVariant });
  const res = upsertCatalog(readCatalog(catalogPath), entry);
  writeCatalogAtomic(catalogPath, res.catalog);
  log(`[merch] catalog entry ${res.action} as "${res.id}" in ${catalogPath} (${images.length} mockup image(s))`);
  log('[merch] Product is NOT published. Review it in Printify, then commit store/catalog.json and deploy.');
  return { ok: true, printifyProductId, entry };
}

function fmt(c) { return `$${(c / 100).toFixed(2)}`; }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`[merch] ERROR: ${err.message}`);
    process.exit(err.exitCode || 1);
  });
}
