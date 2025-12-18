// InlineImageAssets - backend (Node.js) helpers for serving extension-bundled assets.
//
// Why this exists:
// - Browser-side extensions cannot safely list/read local files.
// - To allow "{{macro::...}}" to resolve to real URLs and to list files,
//   we expose a small, locked-down API that only serves files inside THIS extension folder.
//
// Security goals:
// - Prevent directory traversal (..), path injection, absolute paths.
// - Avoid leaking arbitrary files from disk.
// - Restrict to extension root + optional allowed subfolders.
//
// Performance goals:
// - Use ETag + Cache-Control for client caching.
// - Keep an in-memory LRU cache for small assets.
//
// NOTE:
// The exact way SillyTavern loads extension backends depends on the manifest key
// used by the host (some builds use manifest.server / manifest.node / etc).
// This file is ready; we will wire it in manifest.json after confirming the host pattern.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// If you want to hard-restrict listing/serving to certain directories, add them here.
// Empty means "anywhere under extension root".
const ALLOWED_ROOT_SUBDIRS = [];

const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
const DEFAULT_CACHE_MAX_ITEMS = 256;

function logInfo(message, ...args) {
  console.log(`[InlineImageAssets:server] ${message}`, ...args);
}

function logWarn(message, ...args) {
  console.warn(`[InlineImageAssets:server] ${message}`, ...args);
}

function logError(message, ...args) {
  console.error(`[InlineImageAssets:server] ${message}`, ...args);
}

function normalizeUserPath(inputPath) {
  const raw = (inputPath ?? '').toString();
  const stripped = raw.replace(/\0/g, '');
  // Normalize slashes and trim whitespace
  const asPosix = stripped.trim().replace(/\\+/g, '/');
  // Remove leading slashes so it's treated as relative
  return asPosix.replace(/^\/+/, '');
}

function isPathAllowed(relativePosixPath) {
  if (ALLOWED_ROOT_SUBDIRS.length === 0) return true;
  const firstSeg = relativePosixPath.split('/')[0] ?? '';
  return ALLOWED_ROOT_SUBDIRS.includes(firstSeg);
}

function resolveSafePath(relativeInput) {
  const rel = normalizeUserPath(relativeInput);
  if (!rel) {
    const error = new Error('Empty path');
    error.code = 'E_BAD_PATH';
    throw error;
  }
  // reject obvious absolute path patterns
  if (/^[a-zA-Z]:\//.test(rel) || rel.startsWith('\\\\')) {
    const error = new Error('Absolute paths are not allowed');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  // Reject traversal segments in a robust way
  const segments = rel.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    const error = new Error('Path traversal segments are not allowed');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  if (!isPathAllowed(rel)) {
    const error = new Error('Path is outside allowed roots');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  const abs = path.resolve(EXTENSION_DIR, ...segments);

  // Ensure the final resolved path stays within EXTENSION_DIR
  const relToRoot = path.relative(EXTENSION_DIR, abs);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    const error = new Error('Resolved path escapes extension root');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  return { relPosix: rel, absPath: abs };
}

function getMimeTypeByExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    // images
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.ico': return 'image/x-icon';

    // text
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.html':
    case '.htm': return 'text/html; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';

    // fonts
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';

    // audio/video (common)
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';

    default: return 'application/octet-stream';
  }
}

function buildEtag(stat) {
  // Weak etag based on size + mtime.
  const base = `${stat.size}:${stat.mtimeMs}`;
  const hash = crypto.createHash('sha1').update(base).digest('hex');
  return `W/\"${hash}\"`;
}

class LruCache {
  constructor(maxItems, maxBytes) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.map = new Map(); // key -> {value, bytes}
    this.totalBytes = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    // refresh LRU
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, bytes) {
    if (bytes > this.maxBytes) return; // too big
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.totalBytes -= prev.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { value, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  evict() {
    while (this.map.size > this.maxItems || this.totalBytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.totalBytes -= oldest?.bytes ?? 0;
    }
  }
}

const fileBufferCache = new LruCache(DEFAULT_CACHE_MAX_ITEMS, DEFAULT_CACHE_MAX_BYTES);

async function statSafe(relativePath) {
  const { relPosix, absPath } = resolveSafePath(relativePath);
  const st = await fs.stat(absPath);
  if (!st.isFile()) {
    const error = new Error('Not a file');
    error.code = 'E_NOT_FILE';
    throw error;
  }
  const mime = getMimeTypeByExtension(absPath);
  const etag = buildEtag(st);
  return {
    ok: true,
    relPath: relPosix,
    mime,
    size: st.size,
    mtimeMs: st.mtimeMs,
    etag,
  };
}

async function readFileCached(relativePath, etag) {
  const cacheKey = `${relativePath}::${etag}`;
  const cached = fileBufferCache.get(cacheKey);
  if (cached) return cached;

  const { absPath } = resolveSafePath(relativePath);
  const buf = await fs.readFile(absPath);
  fileBufferCache.set(cacheKey, buf, buf.byteLength);
  return buf;
}

async function listFilesSafe(relativeDir, { recursive = false } = {}) {
  const dirRel = normalizeUserPath(relativeDir);
  if (dirRel.split('/').some((s) => s === '..' || s === '.')) {
    const error = new Error('Bad directory');
    error.code = 'E_BAD_PATH';
    throw error;
  }
  if (!isPathAllowed(dirRel)) {
    const error = new Error('Directory is outside allowed roots');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  const absDir = path.resolve(EXTENSION_DIR, ...dirRel.split('/'));
  const relToRoot = path.relative(EXTENSION_DIR, absDir);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    const error = new Error('Resolved directory escapes extension root');
    error.code = 'E_BAD_PATH';
    throw error;
  }

  async function walk(currentAbs, currentRel) {
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const entryAbs = path.join(currentAbs, entry.name);
      const entryRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (recursive) {
          out.push(...await walk(entryAbs, entryRel));
        }
      } else if (entry.isFile()) {
        const st = await fs.stat(entryAbs);
        out.push({
          name: entry.name,
          relPath: entryRel.replace(/\\/g, '/'),
          size: st.size,
          mtimeMs: st.mtimeMs,
          mime: getMimeTypeByExtension(entryAbs),
        });
      }
    }
    return out;
  }

  // If directory doesn't exist, return empty list (safe fallback)
  if (!fssync.existsSync(absDir)) return [];

  return walk(absDir, dirRel);
}

/**
 * The exported entry.
 *
 * SillyTavern backend extensions typically receive (app, router) or similar.
 * Since host APIs differ by build, we export a function and keep route wiring simple.
 * Once we confirm the host signature from JS-Slash-Runner, we will adapt this export.
 */
export function initInlineImageAssetsServer({ router, app } = {}) {
  const r = router || app;
  if (!r) {
    logWarn('No router/app provided; backend not mounted.');
    return;
  }

  // Metadata (existence + mime)
  r.get('/api/extensions/inline-image-assets/stat', async (req, res) => {
    try {
      const rel = req.query.path;
      const meta = await statSafe(rel);
      res.setHeader('Cache-Control', 'no-store');
      res.json(meta);
    } catch (err) {
      logWarn('stat failed', err?.message);
      res.status(404).json({ ok: false, error: err?.message || 'Not found' });
    }
  });

  // Serve file bytes
  r.get('/api/extensions/inline-image-assets/file', async (req, res) => {
    try {
      const rel = req.query.path;
      const meta = await statSafe(rel);

      // Conditional requests
      if (req.headers['if-none-match'] && req.headers['if-none-match'] === meta.etag) {
        res.status(304).end();
        return;
      }

      const buf = await readFileCached(meta.relPath, meta.etag);
      res.setHeader('Content-Type', meta.mime);
      res.setHeader('ETag', meta.etag);
      // Long cache; ETag handles invalidation.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(buf);
    } catch (err) {
      logWarn('file failed', err?.message);
      res.status(404).type('application/json').send(JSON.stringify({ ok: false, error: err?.message || 'Not found' }));
    }
  });

  // Directory listing
  r.get('/api/extensions/inline-image-assets/list', async (req, res) => {
    try {
      const dir = req.query.dir ?? '';
      const recursive = String(req.query.recursive ?? '0') === '1';
      const entries = await listFilesSafe(dir, { recursive });

      // Optional extension filter: ext=png,jpg
      const extParam = (req.query.ext ?? '').toString().trim();
      let filtered = entries;
      if (extParam) {
        const allow = new Set(extParam.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
        filtered = entries.filter((e) => allow.has(path.extname(e.name).toLowerCase().replace(/^\./, '')));
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, dir, recursive, entries: filtered });
    } catch (err) {
      logWarn('list failed', err?.message);
      res.status(400).json({ ok: false, error: err?.message || 'Bad request' });
    }
  });

  logInfo('Backend routes mounted: /api/extensions/inline-image-assets/*');
}
