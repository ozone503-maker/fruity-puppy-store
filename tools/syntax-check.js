#!/usr/bin/env node
// Zero-dependency "lint": node --check every .js file in api/, lib/, tools/, test/.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['api', 'lib', 'tools', 'test'];
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
for (const r of roots) { try { walk(r); } catch {} }
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`FAIL ${f}\n${r.stderr}`); } else console.log(`ok   ${f}`);
}
if (failed) { console.error(`${failed} file(s) failed syntax check`); process.exit(1); }
