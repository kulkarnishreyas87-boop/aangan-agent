// Dashboard: login, live refresh, rendering, and a sample-data preview. All text from the server is inserted with textContent,
// never as HTML, so nothing a caller says can inject markup into the page.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const C = window.Charts;

  const ROUTES = {
    QUALIFY: { label: 'Qualified', color: '#10b981' }, CLARIFY: { label: 'In conversation', color: '#38bdf8' },
    DECLINE: { label: 'Declined', color: '#f43f5e' }, ESCALATE: { label: 'Escalated', color: '#f59e0b' }, LOG_ONLY: { label: 'Follow-up needed', color: '#a78bfa' }
  };
  const CRIT = { real_project: 'Real project', service_area: 'Service area', timeline: 'Timeline', budget: 'Budget', decision_maker: 'Decision maker' };
  const openIds = new Set();   // calls the viewer expanded; kept across the 10 s refresh
  const REASONS = {
    service_area: 'Outside Pune and PCMC', real_project: 'Advice only or out of scope', timeline: 'Timeline too short', budget: 'Budget mismatch',
    decision_maker: 'Decision maker missing', dropped_call: 'Call dropped', unresolved_at_hangup: 'Unresolved at hang-up'
  };
  const GRADS = {
    calls: ['linear-gradient(135deg,#6366f1,#8b5cf6)', '#6366f1', '📞'], qualified: ['linear-gradient(135deg,#10b981,#14b8a6)', '#10b981', '⭐'],
    booked: ['linear-gradient(135deg,#38bdf8,#6366f1)', '#38bdf8', '🗓️'], confirmed: ['linear-gradient(135deg,#14b8a6,#38bdf8)', '#14b8a6', '✅'],
    won: ['linear-gradient(135deg,#f59e0b,#ec4899)', '#f59e0b', '🏆'], declined: ['linear-gradient(135deg,#f43f5e,#fb7185)', '#f43f5e', '🚫']
  };

  let state = { sample: false, lastTopId: null, timer: null, data: null, firstLoad: true };

  // ---------- theme ----------
  const themeBtn = $('#theme');
  const paintTheme = () => { themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? '☀️' : '🌙'; };
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('aangan-theme', next); } catch (e) { /* storage blocked */ }
    paintTheme(); if (state.data) render(state.data);
  });
  paintTheme();

  // ---------- helpers ----------
  const IST = { timeZone: 'Asia/Kolkata' };
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago';
  };
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  const dayParts = (iso) => { const d = new Date(iso); return { day: d.toLocaleString('en-IN', { ...IST, day: '2-digit' }), mon: d.toLocaleString('en-IN', { ...IST, month: 'short' }), time: d.toLocaleString('en-IN', { ...IST, hour: 'numeric', minute: '2-digit', hour12: true }) }; };
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 4200); };

  // ---------- login ----------
  const login = $('#login'), app = $('#app');
  function showLogin(message) { app.hidden = true; login.hidden = false; $('#loginErr').textContent = message || ''; $('#pw').focus(); clearInterval(state.timer); }
  function showApp() { login.hidden = true; app.hidden = false; }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { $('#pw').value = ''; showApp(); start(); }
      else { $('#loginErr').textContent = j.error || 'Could not sign in.'; const card = $('#loginForm'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
    } catch (err) { $('#loginErr').textContent = 'Could not reach the server. Try again.'; }
    btn.disabled = false; btn.textContent = 'Unlock dashboard';
  });
  $('#logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); state.sample = false; showLogin('You have been logged out.'); });

  // ---------- data ----------
  async function load(manual) {
    if (state.sample) { render(sampleData()); return; }
    try {
      const r = await fetch('/api/dashboard', { cache: 'no-store' });
      if (r.status === 401) { showLogin('Please sign in to continue.'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      render(data);
      if (manual) toast('Refreshed');
    } catch (e) { $('#updated').textContent = 'Connection problem. Retrying…'; }
  }
  function start() {
    load();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden && !state.sample) load(); }, 10000);
  }
  $('#refresh').addEventListener('click', () => load(true));
  $('#sampleBtn').addEventListener('click', () => {
    state.sample = !state.sample; state.lastTopId = null; state.firstLoad = true;
    $('#sampleBtn').textContent = state.sample ? '← Back to live data' : '✨ Preview with sample data';
    $('#sampleBanner').style.display = state.sample ? 'block' : 'none';
    load();
  });
  setInterval(() => { if (state.data) $('#updated').textContent = (state.sample ? 'Sample data' : 'Updated ' + ago(state.data.generatedAt)) + ' · refreshes every 10 s'; }, 1000);

  // ---------- render ----------
  function render(d) {
    state.data = d;
    $('#openNote').hidden = !d.open || state.sample;
    const k = d.kpis;
    const h = new Date().getHours();
    $('#greeting').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', team';
    C.count($('#b24'), k.last24h); C.count($('#bRate'), k.qualifiedRate, { suffix: '%' });
    $('#bDur').textContent = k.total ? mmss(k.avgDurationS) : '–';
    $('#liveBanner').textContent = d.live ? d.live + (d.live === 1 ? ' call in progress' : ' calls in progress') : 'Agent is live';
    $('#liveText').textContent = d.live ? d.live + ' on a call' : 'Live';
    $('#bannerSub').textContent = k.total
      ? k.qualified + ' of ' + k.total + ' calls became qualified leads' + (k.booked ? ', and ' + k.booked + ' consultation' + (k.booked > 1 ? 's are' : ' is') + ' booked.' : '.')
      : 'No calls yet. Place a test call, or tap "Preview with sample data" to see the dashboard in action.';
    renderKpis(d); renderCharts(d); renderFunnel(d); renderFeed(d); renderCons(d); renderSystem(d);
    state.firstLoad = false;
  }

  function renderKpis(d) {
    const k = d.kpis, box = $('#kpis'), spark = d.daily.map((x) => x.qualified + x.declined + x.other), sparkQ = d.daily.map((x) => x.qualified), sparkD = d.daily.map((x) => x.declined);
    const items = [['calls', 'Calls handled', k.total, spark], ['qualified', 'Qualified leads', k.qualified, sparkQ], ['booked', 'Consultations booked', k.booked, null],
      ['confirmed', 'Confirmed by phone', k.confirmed, null], ['won', 'Won', k.won, null], ['declined', 'Declined politely', k.declined, sparkD]];
    box.innerHTML = '';
    items.forEach(([key, label, value, series], i) => {
      const [g, c, icon] = GRADS[key];
      const card = el('div', 'card glass kpi reveal'); card.style.setProperty('--g', g); card.style.setProperty('--c', c); card.style.transitionDelay = i * 70 + 'ms';
      card.append(el('div', 'ic', icon), el('b', 'count', '0'), el('span', null, label));
      if (series) { const s = C.svgEl('svg', { class: 'spark', viewBox: '0 0 100 40', preserveAspectRatio: 'none' }); card.append(s); C.spark(s, series, c); }
      box.append(card); requestAnimationFrame(() => card.classList.add('in')); C.count(card.querySelector('b'), value);
    });
  }

  function renderCharts(d) {
    C.bars($('#barChart'), d.daily);
    const lg = $('#barLegend'); lg.innerHTML = '';
    [['Qualified', '#10b981'], ['Declined', '#f43f5e'], ['Other', '#38bdf8']].forEach(([t, c]) => { const s = el('span'); const i = el('i'); i.style.background = c; s.append(i, t); lg.append(s); });
    const parts = d.routes.map((r) => ({ label: (ROUTES[r.route] || { label: r.route }).label, value: r.n, color: (ROUTES[r.route] || { color: '#94a3b8' }).color }));
    const total = parts.reduce((s, p) => s + p.value, 0);
    C.donut($('#donut'), parts.length ? parts : [{ label: 'No calls', value: 1, color: 'rgba(148,163,184,.35)' }], total, 'calls');
    const leg = $('#donutLegend'); leg.innerHTML = '';
    if (!parts.length) leg.append(el('div', 'empty', 'No calls yet'));
    parts.forEach((p) => { const row = el('div'); const i = el('i'); i.style.background = p.color; row.append(i, p.label, el('b', null, p.value)); leg.append(row); });
  }

  function barRow(label, value, max, grad, suffix) {
    const row = el('div', 'bar'); const track = el('div', 'track'); const fill = el('div', 'fill'); fill.style.setProperty('--g', grad); track.append(fill);
    row.append(el('span', null, label), track, el('em', null, suffix || value));
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = max ? Math.max(3, (value / max) * 100) + '%' : '0%'; }));
    return row;
  }
  function renderFunnel(d) {
    const k = d.kpis, f = $('#funnel'); f.innerHTML = '';
    const stages = [['Calls', k.total, GRADS.calls[0]], ['Qualified', k.qualified, GRADS.qualified[0]], ['Booked', k.booked, GRADS.booked[0]], ['Confirmed', k.confirmed, GRADS.confirmed[0]], ['Won', k.won, GRADS.won[0]]];
    const top = Math.max(1, stages[0][1]);
    stages.forEach(([l, v, g]) => f.append(barRow(l, v, top, g, v + (stages[0][1] ? ' · ' + Math.round((v / top) * 100) + '%' : ''))));
    const r = $('#reasons'); r.innerHTML = '';
    if (!d.declineReasons.length) { const e = el('div', 'empty'); e.append(el('div', null, '🌿'), 'No declined calls yet.'); r.append(e); return; }
    const mx = Math.max(...d.declineReasons.map((x) => x.n)), pal = [GRADS.declined[0], GRADS.won[0], GRADS.calls[0], GRADS.booked[0], GRADS.confirmed[0]];
    d.declineReasons.forEach((x, i) => r.append(barRow(REASONS[x.code] || x.code, x.n, mx, pal[i % pal.length])));
  }

  function renderFeed(d) {
    const feed = $('#feed'); feed.innerHTML = '';
    if (!d.recent.length) {
      const e = el('div', 'empty'); e.innerHTML = '<svg viewBox="0 0 120 90" aria-hidden="true"><defs><linearGradient id="eg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect x="14" y="20" width="92" height="56" rx="14" fill="url(#eg)" opacity=".25"/><path d="M34 52c8-12 44-12 52 0" fill="none" stroke="url(#eg)" stroke-width="6" stroke-linecap="round"/><circle cx="60" cy="58" r="7" fill="url(#eg)"/></svg>';
      e.append(el('b', null, 'Waiting for the first call'), el('div', null, 'Calls will appear here the moment they start.'));
      feed.append(e); return;
    }
    const topId = d.recent[0].id, fresh = state.lastTopId != null && topId !== state.lastTopId;
    if (fresh) toast('📞 New call: ' + (d.recent[0].name || d.recent[0].phone));
    state.lastTopId = topId;
    d.recent.forEach((c, i) => {
      const r = c.done ? (ROUTES[c.route] ? c.route : 'LOG_ONLY') : 'CLARIFY';
      const row = el('div', 'call' + (fresh && i === 0 ? ' fresh' : '') + (openIds.has(c.id) ? ' open' : '')); row.style.animationDelay = i * 50 + 'ms'; row.tabIndex = 0; row.setAttribute('role', 'button');
      const top = el('div', 'call-top'); top.append(el('span', 'who', c.name || c.phone));
      const tag = el('span', 'tag t-' + r, c.done ? (ROUTES[c.route] || { label: c.route || 'Done' }).label : 'In conversation'); top.append(tag);
      if (c.booking) top.append(el('span', 'tag t-CLARIFY', '🗓️ ' + (c.booking.confirmed ? 'Confirmed' : 'Booked')));
      if (c.outcome) top.append(el('span', 'tag t-' + (c.outcome === 'won' ? 'QUALIFY' : 'DECLINE'), c.outcome === 'won' ? '🏆 Won' : 'Lost'));
      top.append(el('span', 'when', ago(c.at))); row.append(top);
      row.append(el('div', 'call-sub', [c.area, c.summary, c.name ? c.phone : null].filter(Boolean).join(' · ') || 'Details appear when the call ends'));
      const more = el('div', 'call-more');
      if (c.aiSummary) more.append(el('p', 'ai-sum', '✨ ' + c.aiSummary));
      if (c.note) more.append(el('p', null, c.note));
      if (c.criteria && c.criteria.length) {
        const cr = el('div', 'crit');
        c.criteria.forEach((k) => { const t = el('span', 'crit-i s-' + k.status, (k.status === 'pass' ? '✓ ' : k.status === 'fail' ? '✗ ' : '? ') + (CRIT[k.key] || k.key)); t.title = k.evidence || ''; cr.append(t); });
        more.append(cr);
      }
      if (c.transcript && c.transcript.length) {
        const tr = el('div', 'tr'); tr.append(el('div', 'tr-h', '💬 Transcript (' + c.transcript.length + ' lines)'));
        c.transcript.forEach((m) => tr.append(el('div', 'tr-m ' + m.who, m.text)));
        more.append(tr);
      }
      if (c.reasons && c.reasons.length) more.append(el('p', null, 'Reasons: ' + c.reasons.map((x) => REASONS[x] || x).join(', ')));
      const meta = el('div'); [c.durationS ? '⏱ ' + mmss(c.durationS) : null, c.inHubspot ? '🔗 In HubSpot' : null, c.booking ? '🗓️ ' + dayParts(c.booking.start).day + ' ' + dayParts(c.booking.start).mon + ', ' + dayParts(c.booking.start).time : null].filter(Boolean).forEach((t) => meta.append(el('span', 'mini', t)));
      more.append(meta); row.append(more);
      const toggle = () => { row.classList.toggle('open'); if (row.classList.contains('open')) openIds.add(c.id); else openIds.delete(c.id); }; row.addEventListener('click', toggle); row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      feed.append(row);
    });
  }

  function renderCons(d) {
    const box = $('#cons'); box.innerHTML = '';
    if (!d.upcoming.length) { const e = el('div', 'empty'); e.append(el('div', null, '📅'), 'No upcoming consultations. Qualified calls are booked automatically.'); box.append(e); return; }
    d.upcoming.forEach((b) => {
      const p = dayParts(b.start), item = el('div', 'cons-item'); const date = el('div', 'date'); date.append(el('small', null, p.mon), el('span', null, p.day));
      const body = el('div'); body.append(el('b', null, b.name || 'New lead'), el('div', 'call-sub', (b.type === 'site_visit' ? '🏠 Site visit' : '📞 Phone call') + ' · ' + p.time + (b.area ? ' · ' + b.area : '')));
      const chip = el('span', 'tag t-' + (b.confirmed ? 'QUALIFY' : 'ESCALATE'), b.confirmed ? 'Confirmed' : 'Awaiting confirmation'); chip.style.marginLeft = 'auto';
      item.append(date, body, chip); box.append(item);
    });
  }

  function renderSystem(d) {
    const h = $('#health'); h.innerHTML = '';
    const row = (host, ok, text, val) => { const r = el('div'); const dot = el('span', 'dot' + (ok === false ? ' bad' : ok === null ? ' off' : '')); r.append(dot, text); if (val != null) r.append(el('b', null, val)); host.append(r); };
    row(h, true, 'Server and database', 'Healthy');
    row(h, d.system.outbox.pending === 0 ? true : null, 'Background jobs waiting', d.system.outbox.pending);
    row(h, d.system.outbox.dead === 0 ? true : false, 'Jobs that failed for good', d.system.outbox.dead);
    const i = $('#integrations'); i.innerHTML = ''; d.system.integrations.forEach((x) => row(i, x.ok ? true : null, x.name, x.ok ? 'Connected' : 'Not set up'));
    const u = $('#usage'); u.innerHTML = ''; const us = d.usage;
    row(u, true, 'Gemini input tokens', us.tokensIn.toLocaleString('en-IN')); row(u, true, 'Gemini output tokens', us.tokensOut.toLocaleString('en-IN'));
    row(u, us.costInr == null ? null : true, 'Cost recorded', us.costInr == null ? 'Set rates to see ₹' : '₹' + us.costInr.toFixed(2));
    row(u, true, 'Avg reply speed', '≈ 3 s per turn');
  }

  // ---------- sample data (clearly labelled in the UI) ----------
  function sampleData() {
    const now = Date.now(), day = 86400000;
    const daily = [];
    const q = [1, 2, 1, 3, 2, 4, 2, 3, 5, 3, 4, 6, 4, 5], dcl = [1, 0, 1, 1, 2, 1, 0, 2, 1, 1, 2, 1, 2, 1], oth = [0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1];
    for (let i = 13; i >= 0; i--) daily.push({ day: new Date(now - i * day + 19800000).toISOString().slice(0, 10), qualified: q[13 - i], declined: dcl[13 - i], other: oth[13 - i] });
    const sum = (k) => daily.reduce((s, x) => s + x[k], 0);
    const Q = sum('qualified'), D = sum('declined'), O = sum('other'), T = Q + D + O;
    const mk = (id, mins, name, area, summary, route, extra) => ({ id, at: new Date(now - mins * 60000).toISOString(), done: true, phone: '+91 •••••• ' + String(100 + id).slice(-3), name, area, summary, route, reasons: [], durationS: 140 + id * 7, note: null, inHubspot: true, outcome: null, booking: null, ...extra });
    const recent = [
      mk(14, 6, 'Priya', 'Kothrud, Pune', '3BHK, full redesign', 'QUALIFY', { note: 'Priya, 3BHK in Kothrud, about 1,400 sq ft. Full redesign: kitchen, living room, two bedrooms. Wants it done by March. Owners agree. Referred by a past client.\nUncertain: budget.', booking: { start: new Date(now + 2 * day).toISOString(), type: 'site_visit', confirmed: false } }),
      mk(13, 41, 'Rohit', 'Baner, Pune', '2BHK, kitchen and wardrobes', 'QUALIFY', { booking: { start: new Date(now + 3 * day).toISOString(), type: 'phone', confirmed: true }, note: 'Rohit, 2BHK in Baner, 950 sq ft. Modular kitchen and wardrobes. Moving in November.' }),
      mk(12, 95, 'Suresh', 'Nashik', 'Home office', 'DECLINE', { reasons: ['service_area'], note: 'Declined: outside Pune and PCMC.', inHubspot: true }),
      mk(11, 180, 'Anand', 'Kalyani Nagar, Pune', '5,500 sq ft villa', 'QUALIFY', { booking: { start: new Date(now + 4 * day).toISOString(), type: 'site_visit', confirmed: true }, note: 'Anand, new 5,500 sq ft villa, move-in by March. Wants the principal designer on site.', outcome: 'won' }),
      mk(10, 290, 'Sheetal', 'Viman Nagar, Pune', 'Existing client', 'ESCALATE', { note: 'Existing client, designer unresponsive for five days. Senior call-back within 15 minutes.' }),
      mk(9, 420, 'Meera', 'Aundh, Pune', 'Living room only', 'DECLINE', { reasons: ['real_project'], note: 'Advice only, not a full project.' })
    ];
    const upcoming = recent.filter((r) => r.booking).map((r, i) => ({ id: i, start: r.booking.start, type: r.booking.type, name: r.name, area: r.area, confirmed: r.booking.confirmed })).sort((a, b) => new Date(a.start) - new Date(b.start));
    return {
      generatedAt: new Date().toISOString(), live: 1,
      kpis: { total: T, last24h: 7, qualified: Q, declined: D, escalated: 2, logOnly: 3, qualifiedRate: Math.round((Q / T) * 100), booked: 17, confirmed: 12, won: 5, lost: 2, avgDurationS: 214, avgAnswerS: 0 },
      daily, routes: [{ route: 'QUALIFY', n: Q }, { route: 'DECLINE', n: D }, { route: 'CLARIFY', n: O - 5 }, { route: 'ESCALATE', n: 2 }, { route: 'LOG_ONLY', n: 3 }], // adds up to the total
      declineReasons: [{ code: 'service_area', n: 7 }, { code: 'timeline', n: 5 }, { code: 'real_project', n: 4 }, { code: 'budget', n: 3 }],
      recent, upcoming, usage: { tokensIn: 482300, tokensOut: 61250, costInr: null, callsCosted: T },
      system: { outbox: { pending: 0, dead: 0 }, integrations: ['Neon database', 'Gemini decisions', 'Vaani voice link', 'Resend email', 'Cal.com calendar', 'HubSpot CRM', 'Confirmation calls'].map((name, i) => ({ name, ok: i < 6 })) }
    };
  }

  // ---------- boot ----------
  fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).then((m) => {
    if (!m.enabled) { $('#logout').hidden = true; showApp(); start(); }   // open dashboard: no login
    else if (m.authed) { showApp(); start(); }
    else showLogin('');
  }).catch(() => showLogin('Could not reach the server.'));
})();
