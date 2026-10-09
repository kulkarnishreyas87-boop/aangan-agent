// Run work that should finish around the response. On Vercel a function can be frozen the moment it responds, which would
// cut a job off half-way, so there we WAIT for the work (up to waitMs) before the caller gets its response, and also register it
// with waitUntil in case the platform will keep the instance alive for the remainder. Anywhere else it just runs and logs failures.
let wait = null;
try { wait = (await import('@vercel/functions')).waitUntil; } catch { /* not on Vercel, or package absent */ }

export async function background(promise, { waitMs = 0 } = {}) {
  const safe = Promise.resolve(promise).catch((e) => console.error('[background]', e?.message ?? e));
  try { if (wait) wait(safe); } catch { /* outside a Vercel request: the promise still runs */ }
  if (process.env.VERCEL && waitMs > 0) {
    let timer;
    await Promise.race([safe, new Promise((r) => { timer = setTimeout(r, waitMs); })]);
    clearTimeout(timer);
  }
  return safe;
}
