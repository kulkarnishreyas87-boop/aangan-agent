// Dashboard login. One shared password (DASHBOARD_PASSWORD) gives a signed, expiring, HttpOnly cookie.
// The dashboard shows call data, so everything under /api/dashboard needs it; the public pages show only counts.
import { createHmac } from 'node:crypto';
import { opt, need } from './config.js';
import { safeEqual } from './vaani.js';

const COOKIE = 'aangan_session';
const TTL_S = 12 * 3600;

export const dashboardEnabled = () => Boolean(opt('DASHBOARD_PASSWORD'));

// A separate secret is used when set; otherwise one is derived from the link-signing secret so no extra setup is needed.
const secret = () => opt('DASHBOARD_SESSION_SECRET') ?? createHmac('sha256', need('ACTION_LINK_SECRET')).update('dashboard-session').digest('hex');
const sign = (exp) => createHmac('sha256', secret()).update(`dash:${exp}`).digest('hex');

export function passwordOk(given) {
  if (!dashboardEnabled()) return false;
  return safeEqual(String(given ?? ''), need('DASHBOARD_PASSWORD'));
}

export function makeSession(now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_S;
  return `${exp}.${sign(exp)}`;
}

export function sessionValid(token, now = Date.now()) {
  if (!token || !dashboardEnabled()) return false;
  const [exp, sig] = String(token).split('.');
  const e = Number(exp);
  if (!Number.isInteger(e) || e * 1000 < now || !sig) return false;
  return safeEqual(sig, sign(e));
}

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const isAuthed = (req) => sessionValid(readCookie(req));

const secureFlag = (req) => (String(req.headers['x-forwarded-proto'] ?? '').startsWith('https') ? '; Secure' : '');
export const sessionCookie = (req, token) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}${secureFlag(req)}`;
export const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`;

// Failed-login throttle: 6 tries per 15 minutes per address (per server instance; the constant delay below applies everywhere).
const attempts = new Map();
export function throttled(ip, now = Date.now()) {
  const a = attempts.get(ip);
  if (!a || now - a.first > 15 * 60 * 1000) return false;
  return a.n >= 6;
}
export function recordFailure(ip, now = Date.now()) {
  const a = attempts.get(ip);
  if (!a || now - a.first > 15 * 60 * 1000) attempts.set(ip, { n: 1, first: now });
  else a.n += 1;
  if (attempts.size > 5000) attempts.clear();
}
export const clearFailures = (ip) => attempts.delete(ip);
export const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();
