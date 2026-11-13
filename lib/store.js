import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultDir = fileURLToPath(new URL('../store/', import.meta.url));
const cache = new Map();

export function loadStore(brand) {
  const key = brand || 'default';
  if (cache.has(key)) return cache.get(key);
  const base = process.env.STORE_DIR || defaultDir;
  const dir = brand ? join(base, 'brands', brand) : base;
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const deptFile = join(dir, 'departments.json');
  const departments = existsSync(deptFile) ? JSON.parse(readFileSync(deptFile, 'utf8')) : null;
  const data = { config, catalog, departments };
  cache.set(key, data);
  return data;
}
