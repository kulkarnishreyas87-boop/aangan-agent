// On Vercel every path is rewritten to /api/server and the function sees that path, not the original one.
// vercel.json passes the original path along as ?__p=<path>; this puts it back so one router serves both Vercel and a normal Node host.
export function restoreUrl(req) {
  if (!req.url) return req.url;
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/api/server' || !u.searchParams.has('__p')) return req.url;
  const original = '/' + u.searchParams.get('__p').replace(/^\/+/, '');
  u.searchParams.delete('__p');
  req.url = original + (u.search || '');
  return req.url;
}
