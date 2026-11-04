#!/usr/bin/env node
// Example: node tools/merch-factory.js --image https://example.com/design.png --blueprint 6 --provider 1 --title "Test Tee"
import { PrintifyClient } from '../lib/printify.js';
import { readFileSync, writeFileSync } from 'node:fs';

const client = new PrintifyClient();

async function main() {
  const args = process.argv.slice(2);
  const imageUrl = args[args.indexOf('--image') + 1];
  const title = args[args.indexOf('--title') + 1] || 'Custom Merch';
  const blueprint = Number(args[args.indexOf('--blueprint') + 1] || 6);
  const provider = Number(args[args.indexOf('--provider') + 1] || 1);
  if (!imageUrl) { console.error('Need --image URL'); process.exit(1); }

  console.log('Uploading...');
  const uploaded = await client.uploadImage({ file_name: 'design.png', url: imageUrl });
  console.log('Uploaded id:', uploaded.id);

  // Minimal variants - real use should query blueprint for available ids
  const variants = [{ id: 17390, price: 2499, is_enabled: true }]; // example
  const product = await client.createProduct({
    title,
    description: 'AI generated merch',
    blueprint_id: blueprint,
    print_provider_id: provider,
    variants,
    print_areas: [{
      variant_ids: variants.map(v => v.id),
      placeholders: [{ position: 'front', images: [{ id: uploaded.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
    }],
  });
  console.log('Created product:', product.id);

  // Wait a bit for mockups
  await new Promise(r => setTimeout(r, 5000));
  const full = await client.getProduct(product.id);
  const images = (full.images || []).map(img => img.src);
  console.log('Mockups:', images);

  // TODO: append to catalog.json with proper variant mapping
  console.log('Add to catalog.json manually or extend this script');
}

main().catch(err => { console.error(err); process.exit(1); });
