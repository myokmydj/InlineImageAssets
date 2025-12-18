// Generates assets.index.json for InlineImageAssets.
//
// Why:
// - SillyTavern extensions are front-end files served statically.
// - Browsers cannot list local directories.
// - To support a "list files" macro safely, we ship a prebuilt index.
//
// Usage (from the extension folder):
//   node tools/build-assets-index.mjs
//
// Output:
//   assets.index.json (in extension root)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(EXT_ROOT, 'assets.index.json');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'tools',
]);

const IGNORE_FILES = new Set([
  'assets.index.json',
]);

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

async function walk(dirAbs, relBase = '') {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (IGNORE_FILES.has(entry.name)) continue;

    const abs = path.join(dirAbs, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...await walk(abs, rel));
      continue;
    }

    if (!entry.isFile()) continue;

    out.push({ relPath: toPosix(rel) });
  }

  return out;
}

const entries = await walk(EXT_ROOT);
entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

const payload = {
  ok: true,
  generatedAt: new Date().toISOString(),
  entries,
};

await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`[InlineImageAssets] Wrote ${entries.length} entries -> ${OUT_FILE}`);
