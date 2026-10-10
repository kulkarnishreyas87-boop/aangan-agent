// Landing page behaviour: slideshow, headline reveal, live counters, scroll reveals, typed demo call, credits.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // theme
  const themeBtn = $('#theme');
  const paintTheme = () => { themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? '☀️' : '🌙'; };
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('aangan-theme', next); } catch (e) { /* storage blocked */ }
    paintTheme();
  });
  paintTheme();

  // headline: word-by-word reveal (keeps the gradient span intact)
  const h = $('#headline');
  let delay = 0.1;
  const wrap = (node) => {
    if (node.nodeType === 3) {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((t) => {
        if (!t.trim()) { frag.appendChild(document.createTextNode(t)); return; }
        const s = document.createElement('span'); s.className = 'w'; s.textContent = t; s.style.animationDelay = (delay += 0.07) + 's'; frag.appendChild(s);
      });
      node.replaceWith(frag);
    } else if (node.childNodes) [...node.childNodes].forEach(wrap);
  };
  wrap(h);

  // slideshow
  const slides = $$('.slides img');
  let cur = 0;
  if (slides.length > 1 && !reduce) setInterval(() => {
    slides[cur].classList.remove('on'); cur = (cur + 1) % slides.length;
    slides[cur].classList.remove('on'); void slides[cur].offsetWidth; slides[cur].classList.add('on');
  }, 6500);
  else slides[0] && slides[0].classList.add('on');

  // count-up
  function countUp(el, to) {
    if (reduce || to < 1) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 1400;
    const tick = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  fetch('/api/public-stats').then((r) => r.json()).then((s) => { countUp($('#c-total'), s.total || 0); countUp($('#c-qual'), s.qualified || 0); }).catch(() => {});

  // scroll reveal
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$('.reveal').forEach((el) => io.observe(el));

  // typed demo
  const lines = [
    ['a', 'Good morning, Aangan Studio. How can I help you today?', null],
    ['u', 'Hi, I have a 3BHK in Kothrud and want the whole flat redone.', 0],
    ['a', 'Lovely! About how big is it, and when would you like it finished?', null],
    ['u', 'Around 1,400 sq ft, by March. I am the owner, my husband agrees.', 2],
    ['a', 'Perfect. When are you free for a first consultation?', null],
    ['u', 'Weekday mornings work best for us.', 4]
  ];
  const crits = [
    ['Real project', 'Full redesign with execution', true], ['Service area', 'Kothrud, Pune', true],
    ['Timeline', 'By March, realistic', true], ['Budget', 'Not mentioned, flagged for the designer', 'warn'], ['Decision maker', 'Owner, spouse agrees', true]
  ];
  const phone = $('#phone'), verdict = $('#verdict');
  lines.forEach(([who, text]) => { const b = document.createElement('div'); b.className = 'bubble ' + who; b.textContent = text; phone.appendChild(b); });
  crits.forEach(([t, d, ok]) => {
    const c = document.createElement('div'); c.className = 'crit glass' + (ok === 'warn' ? ' warn' : '');
    c.innerHTML = '<span class="ok">' + (ok === 'warn' ? '!' : '✓') + '</span><div><b>' + t + '</b><br><small style="margin:0">' + d + '</small></div>'; verdict.appendChild(c);
  });
  const result = document.createElement('div'); result.className = 'crit glass'; result.style.cssText = 'background:linear-gradient(135deg,rgba(16,185,129,.25),rgba(99,102,241,.25))';
  result.innerHTML = '<span class="ok">★</span><div><b>Route: Qualify</b><br><small style="margin:0">Consultation booked, designer emailed</small></div>'; verdict.appendChild(result);

  // which checks light up after each caller line (index into the conversation), and the final verdict
  const LIGHT = { 1: [0, 1], 3: [2, 4, 3], 5: [5] };
  function play() {
    const bubbles = $$('.bubble', phone), items = $$('.crit', verdict);
    bubbles.forEach((b) => b.classList.remove('show')); items.forEach((c) => c.classList.remove('on'));
    let t = 500;
    bubbles.forEach((b, i) => {
      setTimeout(() => b.classList.add('show'), t);
      (LIGHT[i] || []).forEach((k, n) => setTimeout(() => items[k] && items[k].classList.add('on'), t + 650 + n * 450));
      t += 1600;
    });
    return t + 4500; // pause, then replay
  }
  if (reduce) { $$('.bubble', phone).forEach((b) => b.classList.add('show')); $$('.crit', verdict).forEach((c) => c.classList.add('on')); }
  else {
    let started = false;
    new IntersectionObserver((es, ob) => es.forEach((e) => { if (e.isIntersecting && !started) { started = true; const loop = () => setTimeout(loop, play()); loop(); ob.disconnect(); } }), { threshold: 0.35 }).observe(phone);
  }

  // areas marquee
  const areas = ['Kothrud', 'Baner', 'Aundh', 'Wakad', 'Koregaon Park', 'Kalyani Nagar', 'Viman Nagar', 'Hadapsar', 'Magarpatta', 'Pimple Saudagar', 'Hinjewadi', 'Kharadi', 'NIBM', 'Undri'];
  $('#areas').innerHTML = areas.concat(areas).map((a) => '<span>' + a + '</span>').join('');

  // credits
  fetch('/img/credits.json').then((r) => r.json()).then((list) => {
    const box = $('#credits');
    (Array.isArray(list) ? list : [list]).forEach((c) => {
      const a = document.createElement('a'); a.href = c.source; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (c.artist || 'Unknown') + ' (' + c.license + ')'; box.appendChild(a);
    });
  }).catch(() => {});
})();
