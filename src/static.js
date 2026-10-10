// Serves the site in public/ from the function itself, so it behaves the same on Vercel and on any Node host.
import { readFile } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
const PAGES = { '/': 'index.html', '/dashboard': 'dashboard.html' };

/** Returns true if it answered the request. Never serves anything outside public/. */
export async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rel = PAGES[path] ?? decodeURIComponentSafe(path).replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return false;
  const file = normalize(ROOT + rel);
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return false; // path traversal
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return false;
  let body;
  try { body = await readFile(file); } catch { return false; }
  const isPage = type.startsWith('text/html');
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    // Pages always revalidate; code files for 5 minutes so design updates reach visitors quickly; photos for a day.
    'cache-control': isPage ? 'no-cache' : (type.startsWith('text/css') || type.startsWith('text/javascript')) ? 'public, max-age=300, must-revalidate' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    ...(isPage ? { 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' } : {})
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return ''; } }
