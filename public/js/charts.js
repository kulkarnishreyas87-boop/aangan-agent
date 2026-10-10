// Tiny dependency-free SVG charts with entrance animations. Everything is drawn from the data passed in.
window.Charts = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const tip = () => document.getElementById('tip');
  const showTip = (html, x, y) => { const t = tip(); t.innerHTML = html; t.style.left = Math.min(x + 14, innerWidth - 190) + 'px'; t.style.top = y + 14 + 'px'; t.style.opacity = 1; };
  const hideTip = () => { tip().style.opacity = 0; };
  const grad = (defs, id, c1, c2) => { const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs); svgEl('stop', { offset: '0', 'stop-color': c1 }, g); svgEl('stop', { offset: '1', 'stop-color': c2 }, g); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Stacked bars per day: qualified (green), declined (red), other (blue). */
  function bars(svg, days) {
    svg.innerHTML = '';
    const W = 700, H = 260, padL = 34, padB = 28, padT = 12, innerH = H - padB - padT;
    const defs = svgEl('defs', {}, svg);
    grad(defs, 'gq', '#34d399', '#059669'); grad(defs, 'gd', '#fb7185', '#e11d48'); grad(defs, 'go', '#7dd3fc', '#2563eb');
    const max = Math.max(4, ...days.map((d) => d.qualified + d.declined + d.other));
    const nice = Math.ceil(max / 4) * 4;
    for (let i = 0; i <= 4; i++) {
      const y = padT + innerH - (innerH * i) / 4;
      svgEl('line', { x1: padL, x2: W, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': 0.12 }, svg);
      const t = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.55 }, svg); t.textContent = Math.round((nice * i) / 4);
    }
    const slot = (W - padL) / days.length, bw = Math.min(34, slot * 0.62);
    days.forEach((d, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      let y = padT + innerH;
      const g = svgEl('g', {}, svg);
      [['qualified', 'gq'], ['declined', 'gd'], ['other', 'go']].forEach(([key, gid], idx) => {
        const h = (d[key] / nice) * innerH;
        if (!h) return;
        y -= h;
        const r = svgEl('rect', { x, width: bw, rx: 5, fill: 'url(#' + gid + ')' }, g);
        r.style.y = padT + innerH + 'px'; r.style.height = '0px';
        r.style.transition = 'y .9s cubic-bezier(.2,.8,.2,1), height .9s cubic-bezier(.2,.8,.2,1)'; r.style.transitionDelay = (i * 40 + idx * 80) + 'ms';
        const ty = y;
        requestAnimationFrame(() => requestAnimationFrame(() => { r.style.y = ty + 'px'; r.style.height = h + 'px'; }));
      });
      if (i % 2 === 0 || days.length < 9) { const lt = svgEl('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.55 }, svg); lt.textContent = d.day.slice(8) + '/' + d.day.slice(5, 7); }
      const hit = svgEl('rect', { x: padL + slot * i, y: padT, width: slot, height: innerH, fill: 'transparent' }, svg);
      hit.addEventListener('mousemove', (e) => showTip('<b>' + d.day + '</b><br>Qualified: ' + d.qualified + '<br>Declined: ' + d.declined + '<br>Other: ' + d.other, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTip);
    });
  }

  /** Donut with animated segments and a centre total. parts: [{label,value,color}] */
  function donut(svg, parts, total, centreLabel) {
    svg.innerHTML = '';
    const R = 74, C = 2 * Math.PI * R, cx = 100, cy = 100;
    svgEl('circle', { cx, cy, r: R, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.1, 'stroke-width': 20 }, svg);
    let offset = 0;
    const sum = parts.reduce((s, p) => s + p.value, 0) || 1;
    parts.forEach((p, i) => {
      const len = (p.value / sum) * C;
      const c = svgEl('circle', { cx, cy, r: R, fill: 'none', stroke: p.color, 'stroke-width': 20, 'stroke-linecap': 'butt', transform: 'rotate(-90 100 100)' }, svg);
      c.style.strokeDasharray = '0 ' + C; c.style.strokeDashoffset = -offset;
      c.style.transition = 'stroke-dasharray 1.1s cubic-bezier(.2,.8,.2,1) ' + i * 140 + 'ms';
      requestAnimationFrame(() => requestAnimationFrame(() => { c.style.strokeDasharray = Math.max(0, len - 3) + ' ' + C; }));
      c.addEventListener('mousemove', (e) => showTip('<b>' + p.label + '</b><br>' + p.value + ' calls (' + Math.round((p.value / sum) * 100) + '%)', e.clientX, e.clientY));
      c.addEventListener('mouseleave', hideTip);
      offset += len;
    });
    const t1 = svgEl('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 34, 'font-weight': 600, 'font-family': 'Fraunces, Georgia, serif' }, svg); t1.textContent = total;
    const t2 = svgEl('text', { x: cx, y: cy + 24, 'text-anchor': 'middle', 'font-size': 11, 'fill-opacity': 0.6, 'letter-spacing': '.08em' }, svg); t2.textContent = (centreLabel || 'CALLS').toUpperCase();
  }

  /** Smooth sparkline with area fill that draws itself. */
  function spark(svg, values, color) {
    svg.innerHTML = '';
    const W = 100, H = 40, n = values.length, max = Math.max(1, ...values);
    const pts = values.map((v, i) => [(i / Math.max(1, n - 1)) * W, H - 4 - (v / max) * (H - 10)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const id = 'sg' + Math.random().toString(36).slice(2, 7);
    const defs = svgEl('defs', {}, svg); const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.5 }, g); svgEl('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }, g);
    const area = svgEl('path', { d: d + ' L' + W + ',' + H + ' L0,' + H + ' Z', fill: 'url(#' + id + ')' }, svg); area.style.opacity = 0; area.style.transition = 'opacity 1s .4s';
    const line = svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }, svg);
    const len = line.getTotalLength ? line.getTotalLength() : 200;
    line.style.strokeDasharray = len; line.style.strokeDashoffset = reduce ? 0 : len; line.style.transition = 'stroke-dashoffset 1.2s ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { line.style.strokeDashoffset = 0; area.style.opacity = 1; }));
    const last = pts[pts.length - 1]; if (last) svgEl('circle', { cx: last[0], cy: last[1], r: 2.8, fill: color }, svg);
  }

  /** Count a number up to its value. */
  function count(el, to, opts) {
    const o = opts || {}; const suffix = o.suffix || ''; const dec = o.decimals || 0;
    if (reduce || to === 0) { el.textContent = to.toFixed(dec) + suffix; return; }
    const from = parseFloat(el.dataset.v || 0) || 0; el.dataset.v = to;
    const t0 = performance.now(), dur = 1100;
    const tick = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = (from + (to - from) * e).toFixed(dec) + suffix; if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  return { bars, donut, spark, count, svgEl };
})();
