#!/usr/bin/env node
// Copy mockups from the original catalog (or a Printify product) onto a brand listing.
// node tools/merch-factory.js --brand kudoken --from kudoken-tee --image https://... --title "Kudoken Tank"
import { PrintifyClient } from '../lib/printify.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function catalogPath(brand) {
  return brand ? join('store', 'brands', brand, 'catalog.json') : join('store', 'catalog.json');
}

function loadCatalog(brand) {
  return JSON.parse(readFileSync(catalogPath(brand), 'utf8'));
}

async function main() {
  const brand = arg('--brand', '');
  const fromId = arg('--from', '');
  const imageUrl = arg('--image', '');
  const title = arg('--title', 'Custom Merch');
  const blueprint = Number(arg('--blueprint', '6'));
  const provider = Number(arg('--provider', '1'));

  const catalog = loadCatalog(brand);
  const original = fromId ? catalog.products.find(p => p.id === fromId) : null;
  let images = original?.images ? [...original.images] : [];

  if (imageUrl) {
    const client = new PrintifyClient();
    console.log('Uploading design...');
    const uploaded = await client.uploadImage({ file_name: 'design.png', url: imageUrl });
    const variants = [{ id: 17390, price: 2499, is_enabled: true }];
    const product = await client.createProduct({
      title,
      description: original?.description || title,
      blueprint_id: blueprint,
      print_provider_id: provider,
      variants,
      print_areas: [{
        variant_ids: variants.map(v => v.id),
        placeholders: [{ position: 'front', images: [{ id: uploaded.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
      }],
    });
    await new Promise(r => setTimeout(r, 5000));
    const full = await client.getProduct(product.id);
    const mockups = (full.images || []).map(img => img.src).filter(Boolean);
    if (mockups.length) images = mockups;
    console.log('Printify product', product.id, 'mockups', images.length);
  }

  if (!images.length) {
    console.error('No mockups to copy. Pass --from <catalog product id> or --image <design url>.');
    process.exit(1);
  }

  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const existing = catalog.products.find(p => p.id === id);
  if (existing) {
    existing.images = images;
    console.log('Copied', images.length, 'mockups onto', existing.id);
  } else {
    catalog.products.push({
      id,
      title,
      brand: brand || 'Store',
      description: original?.description || title,
      images,
      tags: [],
      pairs: original ? [original.id] : [],
      fulfiller: 'printify',
      variants: [{ sku: id.toUpperCase().slice(0, 12), title: 'Default', price_cents: 2800, active: true }],
    });
    console.log('Added', id, 'with', images.length, 'mockups from', fromId || 'Printify');
  }

  writeFileSync(catalogPath(brand), JSON.stringify(catalog, null, 2) + '\n');
  console.log('Wrote', catalogPath(brand));
}

main().catch(err => { console.error(err); process.exit(1); });
