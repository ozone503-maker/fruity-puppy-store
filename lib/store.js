import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultDir = fileURLToPath(new URL('../store/', import.meta.url));
let cached = null;
export function loadStore() {
  if (cached) return cached;
  const dir = process.env.STORE_DIR || defaultDir;
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  cached = { config, catalog };
  return cached;
}
