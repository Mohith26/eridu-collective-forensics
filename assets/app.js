import * as X from '../core/forensics.mjs';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const C = { bb: '#1e3239', blue: '#08c6cb', green: '#03c55f', cool: '#02989a', gray: '#b6b4b1', lg: '#ededed', orange: '#f2a33a', grid: '#e6e9ea', axis: '#6b7376', div: '#479fa5' };
const US = X.US;
const us = (x, d = 0) => (x / US).toFixed(d);
const fmtEps = (e) => e >= 1e-6 ? `±${+(e * 1e6).toFixed(e >= 1e-5 ? 0 : 1)} µs` : `±${Math.round(e * 1e9)} ns`;
const CAUSE = {
  straggler: { label: 'Late sender', color: C.orange, what: (w) => `xPU ${w} started late` },
  incast: { label: 'Hot expert (incast)', color: C.cool, what: (w) => `xPU ${w} received the most tokens` },
  link: { label: 'Degraded port', color: '#7b5ea7', what: (w) => `xPU ${w} port below line rate` },
  none: { label: 'No fault', color: C.green, what: () => 'within budget' },
  abstain: { label: 'Clock too loose', color: C.gray, what: () => 'intervals overlap' },
};
const tip = $('tip');
const showTip = (h, ev) => { tip.innerHTML = h; tip.style.opacity = 1; tip.style.left = Math.min(innerWidth - 310, ev.clientX + 14) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; };
const hideTip = () => { tip.style.opacity = 0; };

// ---------- data ----------
const S = X.generateSession();
const cfg = S.cfg;
const truth = S.steps.map(s => X.truthOf(s, cfg));
let clockIdx = 2;
let R = X.replay(S, X.CLOCKS[clockIdx].eps, truth);
let grid = null;
let filter = 'slow';
let selected = null;
let showTruth = false;

$('hdrMeta').innerHTML = `<b>SU-01</b> · ${cfg.N}-xPU slice · ${cfg.N / cfg.PER_RACK} compute racks<br>${(cfg.B * 8 / 1e12).toFixed(1)} Tb/s per xPU port · single hop`;
$('thTxt').textContent = `${cfg.THETA_US} µs`;
$('modelBox').innerHTML = `<b>Replay set.</b> ${S.steps.length} MoE dispatch steps: ${cfg.TOKENS.toLocaleString()} tokens per xPU, top-${cfg.TOP_K} routing over ${cfg.N * cfg.EXPERTS_PER_XPU} experts, ${cfg.HIDDEN_BYTES.toLocaleString()} B per token (fp8), so ${(cfg.TOKENS * cfg.TOP_K * cfg.HIDDEN_BYTES / 1e6).toFixed(0)} MB leaves every xPU and a clean step takes about ${us(S.nominal)} µs. Injected incidents: late senders (6 to 96 µs), hot experts (2 to 12% extra load on one destination), degraded ports (93 to 99% of line rate), plus natural ±${cfg.JITTER_US} µs start jitter. Each NIC clock carries a fixed offset inside its bound.`;

// ---------- clock selector ----------
function drawClock() {
  $('clockSeg').innerHTML = X.CLOCKS.map((c, k) => `<button type="button" class="${k === clockIdx ? 'on' : ''}" data-k="${k}">${c.label}</button>`).join('');
  $('clockSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { clockIdx = +b.dataset.k; R = X.replay(S, X.CLOCKS[clockIdx].eps, truth); drawAll(); }));
  $('clockNote').textContent = `${X.CLOCKS[clockIdx].note}. Each saving gets an interval of ±${fmtEps(2 * X.CLOCKS[clockIdx].eps).slice(1)}.`;
}

// ---------- KPIs ----------
function drawKpis() {
  const s = R.summary;
  const budget = grid ? X.budgetFromGrid(grid, 0.9) : null;
  $('kpis').innerHTML = [
    { k: 'Slow collectives', v: s.incidents, sm: `of ${S.steps.length} steps`, d: `a real fault costing ≥ ${cfg.THETA_US} µs` },
    { k: 'Named with proof', v: `${Math.round(s.resolved / s.incidents * 100)}%`, sm: `${s.resolved} of ${s.incidents}`, d: 'cause and component, interval-certain' },
    { k: 'Abstained', v: s.abstain, sm: 'steps', d: `intervals overlap at ${X.CLOCKS[clockIdx].label}` },
    { k: 'Wrong calls', v: s.boundWrong, sm: 'bound-aware', d: `naive argmax: ${s.naiveWrong} wrong of ${s.n}`, ok: s.boundWrong === 0 },
    { k: 'Clock budget', v: budget ? fmtEps(budget) : '…', sm: '', d: budget ? 'loosest bound that names ≥ 90% with 0 wrong' : 'computing across 13 bounds' },
  ].map(x => `<div class="kpi${x.ok ? ' ok' : ''}"><div class="k">${x.k}</div><div class="v">${x.v}${x.sm ? `<small>${x.sm}</small>` : ''}</div><div class="d">${x.d}</div></div>`).join('');
}

// ---------- domain racks ----------
function culpritOf(row) { return row.v.bound === 'straggler' ? row.h.straggler.who : row.v.bound === 'incast' ? row.h.incast.who : row.v.bound === 'link' ? row.h.link.who : null; }
function drawDomain() {
  const svg = $('dom'); svg.innerHTML = '';
  const named = new Map();
  for (const r of R.rows) { const c = culpritOf(r); if (c !== null) named.set(c, (named.get(c) || 0) + 1); }
  const sel = selected !== null ? R.rows[selected] : null;
  const selWho = sel ? (culpritOf(sel) ?? (sel.v.naive !== 'none' ? sel.naiveWho : null)) : null;
  // overhead fiber tray
  el('rect', { x: 20, y: 140, width: 600, height: 20, rx: 6, fill: 'rgba(8,198,203,.10)', stroke: 'rgba(8,198,203,.55)', 'stroke-dasharray': '4 4' }, svg);
  el('text', { x: 30, y: 154, fill: C.cool, 'font-size': 10.5, 'letter-spacing': '.08em' }, svg).textContent = 'FIBER ON OVERHEAD TRAY · OCI';
  const racksPerRow = cfg.N / cfg.PER_RACK / 2;
  const rackW = 70, gap = 12, x0 = 20;
  const pos = [];
  for (let row = 0; row < 2; row++) for (let k = 0; k < racksPerRow; k++) {
    const rack = row * racksPerRow + k;
    const x = x0 + k * (rackW + gap) + (k >= racksPerRow / 2 ? 82 : 0), y = row === 0 ? 20 : 180;
    el('rect', { x, y, width: rackW, height: 100, rx: 8, fill: '#fff4e3', stroke: '#e7b56b' }, svg);
    el('text', { x: x + rackW / 2, y: y + 96, 'text-anchor': 'middle', fill: '#9a6a1d', 'font-size': 9.5 }, svg).textContent = `C${String(rack + 1).padStart(2, '0')}`;
    for (let m = 0; m < cfg.PER_RACK; m++) {
      const i = rack * cfg.PER_RACK + m;
      const cx = x + 10 + (m % 2) * 30, cy = y + 8 + Math.floor(m / 2) * 19;
      const n = named.get(i) || 0;
      const r = el('rect', { x: cx, y: cy, width: 22, height: 14, rx: 3, fill: n ? (n > 2 ? '#c97c12' : C.orange) : '#f8d9a8', stroke: selWho === i ? C.bb : 'none', 'stroke-width': 2.2, style: 'cursor:pointer' }, svg);
      r.addEventListener('mousemove', ev => showTip(`<b>xPU ${i}</b> · rack C${String(rack + 1).padStart(2, '0')}<br>Named culprit in ${n} step${n === 1 ? '' : 's'} at ${X.CLOCKS[clockIdx].label}`, ev));
      r.addEventListener('mouseleave', hideTip);
      pos[i] = [cx + 11, cy + 7];
    }
  }
  // switch racks in the middle of each row (single tier)
  for (const y of [20, 180]) {
    const x = x0 + (racksPerRow / 2) * (rackW + gap) - 2;
    el('rect', { x, y, width: 72, height: 100, rx: 8, fill: '#e1f7ec', stroke: C.green }, svg);
    for (let m = 0; m < 4; m++) el('rect', { x: x + 10, y: y + 10 + m * 18, width: 52, height: 11, rx: 3, fill: 'rgba(3,197,95,.55)' }, svg);
    el('text', { x: x + 36, y: y + 96, 'text-anchor': 'middle', fill: '#018a43', 'font-size': 9.5 }, svg).textContent = 'SWITCH';
  }
  if (selWho !== null && pos[selWho]) {
    const [px, py] = pos[selWho];
    el('circle', { cx: px, cy: py, r: 15, fill: 'none', stroke: C.blue, 'stroke-width': 2 }, svg);
    el('line', { x1: px, y1: py + (py < 140 ? 15 : -15), x2: px, y2: py < 140 ? 140 : 160, stroke: C.blue, 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }, svg);
  }
  $('domSub').textContent = `${cfg.N / cfg.PER_RACK} compute racks, 2 switch racks, one hop between any two xPUs`;
  $('domLegend').innerHTML = `<span><i style="background:#f8d9a8"></i>xPU</span><span><i style="background:${C.orange}"></i>named culprit (1-2 steps)</span><span><i style="background:#c97c12"></i>named in 3+ steps</span><span><i style="background:rgba(3,197,95,.55)"></i>switch</span><span><i style="background:#fff;border:2px solid ${C.blue}"></i>selected step</span>`;
}

// ---------- incident table ----------
function listRows() {
  const slow = R.rows.filter(r => r.v.bound !== 'none' || r.v.naive !== 'none');
  const groups = {
    slow, named: R.rows.filter(r => ['straggler', 'incast', 'link'].includes(r.v.bound)), abstain: R.rows.filter(r => r.v.bound === 'abstain'),
    disagree: R.rows.filter(r => r.v.bound !== 'abstain' ? false : r.v.naive !== 'none'), all: R.rows,
  };
  return groups;
}
function verdictText(r) {
  const b = r.v.bound;
  if (b === 'abstain') return `<span class="pill"><span class="d" style="background:${C.gray}"></span>Clock too loose</span>`;
  if (b === 'none') return `<span class="pill"><span class="d" style="background:${C.green}"></span>No fault</span>`;
  return `<span class="pill"><span class="d" style="background:${CAUSE[b].color}"></span>${CAUSE[b].label} · xPU ${culpritOf(r)}</span>`;
}
function truthTag(r) {
  const t = r.truth.label, inj = r.inject;
  if (!inj) return '<span class="tag good">clean</span>';
  const txt = `${CAUSE[inj.type].label.split(' (')[0]} · xPU ${inj.who}${t === 'minor' ? ' (minor)' : ''}`;
  const b = r.v.bound;
  const ok = b === 'abstain' || (t === 'minor') || (b === t && culpritOf(r) === inj.who);
  return `<span class="tag ${ok ? 'good' : 'bad'}">${txt}</span>`;
}
function drawTable() {
  const g = listRows();
  const names = { slow: 'Flagged', named: 'Named', abstain: 'Abstained', disagree: 'Naive would guess', all: 'All steps' };
  $('filters').innerHTML = Object.keys(names).map(k => `<button type="button" class="chipf${filter === k ? ' on' : ''}" data-f="${k}">${names[k]}<b>${g[k].length}</b></button>`).join('');
  $('filters').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; drawTable(); }));
  const rows = g[filter].slice().sort((a, b) => b.slow - a.slow);
  const w = 2 * X.CLOCKS[clockIdx].eps;
  $('incTbl').innerHTML = `<tr><th>Step</th><th class="num">Over nominal</th><th>Verdict</th><th class="num">Saving if fixed</th>${showTruth ? '<th>Injected</th>' : ''}</tr>` +
    rows.map(r => {
      const k = r.v.k; const c = X.CAUSES[k]; const gain = r.h[c].gain;
      return `<tr class="r${selected === r.k ? ' sel' : ''}" data-k="${r.k}"><td>#${r.k + 1}</td><td class="num">+${us(r.F - S.nominal, 0)} µs</td><td>${verdictText(r)}</td><td class="num">${us(Math.max(0, gain - w), 0)} to ${us(gain + w, 0)} µs</td>${showTruth ? `<td>${truthTag(r)}</td>` : ''}</tr>`;
    }).join('');
  $('incTbl').querySelectorAll('tr.r').forEach(tr => tr.addEventListener('click', () => { selected = +tr.dataset.k; drawTable(); drawDetail(); drawDomain(); }));
}

// ---------- detail ----------
function drawDetail() {
  const r = R.rows[selected];
  const eps = X.CLOCKS[clockIdx].eps, w = 2 * eps, th = cfg.THETA_US * US;
  const b = r.v.bound;
  const cls = b === 'abstain' ? 'abstain' : b === 'none' ? 'none' : '';
  const vtxt = b === 'abstain' ? 'Clock too loose to tell' : b === 'none' ? 'No fault' : `${CAUSE[b].label}: xPU ${culpritOf(r)}`;
  const st = S.steps[r.k];
  const sHat = X.observe(st, S.offs, eps).sHat;
  const med = X.median(sHat);
  const gains = X.CAUSES.map(c => r.h[c].gain);
  const order = gains.map((g, i) => [g, i]).sort((a, b2) => b2[0] - a[0]);
  const top = X.CAUSES[order[0][1]], second = X.CAUSES[order[1][1]];
  let explain;
  if (b === 'abstain') explain = `The best explanation is ${CAUSE[top].what(r.h[top].who)} (saving ${us(r.h[top].gain, 0)} µs), but with ${fmtEps(eps)} clocks it could be anywhere from ${us(Math.max(0, r.h[top].gain - w), 0)} to ${us(r.h[top].gain + w, 0)} µs, which overlaps ${r.h[top].gain - w < th ? `the ${cfg.THETA_US} µs threshold` : `${CAUSE[second].label.toLowerCase()} (up to ${us(r.h[second].gain + w, 0)} µs)`}. A naive tool would report "${r.v.naive === 'none' ? 'no fault' : CAUSE[r.v.naive].label.toLowerCase() + ', xPU ' + r.naiveWho}" here${showTruth && r.inject ? `; the injected cause was ${CAUSE[r.inject.type].label.toLowerCase()} on xPU ${r.inject.who}` : ''}.`;
  else if (b === 'none') explain = `Every counterfactual saves less than ${cfg.THETA_US} µs even at the top of its interval, so the extra ${us(r.F - S.nominal, 0)} µs is normal jitter and load spread.`;
  else explain = `Fixing it would have finished the collective ${us(Math.max(0, r.h[b].gain - w), 0)} to ${us(r.h[b].gain + w, 0)} µs sooner. The next-best explanation, ${CAUSE[second].label.toLowerCase()}, saves at most ${us(r.h[second].gain + w, 0)} µs, so the call holds for any clock offsets inside ${fmtEps(eps)}.`;
  $('detail').innerHTML = `
    <div class="ph"><div class="det-h"><h3>Step #${r.k + 1}</h3><span class="verdict ${cls}">${vtxt}</span><span class="sub">Completed in ${us(r.F, 0)} µs, ${us(r.F - S.nominal, 0)} µs over nominal · clocks ${fmtEps(eps)}</span></div></div>
    <div class="det-grid">
      <div><div class="mini-h">Counterfactual savings with <span class="nc">±2ε</span> intervals</div><svg id="cfChart" viewBox="0 0 640 210"></svg><p class="explain">${explain}</p></div>
      <div><div class="mini-h">Evidence the fabric sees</div><svg id="tlChart" viewBox="0 0 600 260"></svg></div>
    </div>`;

  // counterfactual chart
  const svg = $('cfChart');
  const maxV = Math.max(th * 1.6, ...gains.map(g => g + w)) / US;
  const xm = 190, xM = 520;
  const x = (v) => xm + Math.max(0, v) / maxV * (xM - xm);
  for (let v = 0; v <= maxV; v += maxV > 300 ? 100 : maxV > 120 ? 50 : maxV > 60 ? 20 : 10) {
    el('line', { x1: x(v), x2: x(v), y1: 14, y2: 178, stroke: C.grid }, svg);
    el('text', { x: x(v), y: 194, 'text-anchor': 'middle', fill: C.axis, 'font-size': 11 }, svg).textContent = v + ' µs';
  }
  el('line', { x1: x(cfg.THETA_US), x2: x(cfg.THETA_US), y1: 10, y2: 180, stroke: C.bb, 'stroke-dasharray': '4 3' }, svg);
  el('text', { x: x(cfg.THETA_US) + 4, y: 12, fill: C.bb, 'font-size': 10.5 }, svg).textContent = `${cfg.THETA_US} µs threshold`;
  const labels = { straggler: (h) => `Re-time xPU ${h.who} to median`, incast: (h) => `Rebalance xPU ${h.who} load`, link: (h) => `Restore xPU ${h.who} port` };
  X.CAUSES.forEach((c, i) => {
    const y = 34 + i * 52, g = r.h[c].gain / US, lo = Math.max(0, g - w / US), hi = g + w / US;
    el('text', { x: 0, y: y + 4, fill: '#111', 'font-size': 12.5, 'font-weight': 500 }, svg).textContent = CAUSE[c].label;
    el('text', { x: 0, y: y + 20, fill: C.axis, 'font-size': 11 }, svg).textContent = labels[c](r.h[c]);
    el('rect', { x: xm, y: y - 8, width: Math.max(1, x(g) - xm), height: 16, rx: 4, fill: CAUSE[c].color, opacity: b === c ? 1 : .45 }, svg);
    el('rect', { x: x(lo), y: y - 13, width: Math.max(2, x(hi) - x(lo)), height: 26, rx: 5, fill: 'none', stroke: C.bb, 'stroke-width': 1.3 }, svg);
    el('text', { x: 640, y: y + 4, fill: '#111', 'font-size': 12, 'font-weight': 500, 'text-anchor': 'end' }, svg).textContent = `${g.toFixed(0)} µs`;
    el('text', { x: 640, y: y + 19, fill: C.axis, 'font-size': 10.5, 'text-anchor': 'end' }, svg).textContent = `[${lo.toFixed(0)}, ${hi.toFixed(0)}]`;
  });

  // evidence strips
  const sv = $('tlChart'); const N = cfg.N; const xL = 60, xR = 590;
  const xi = (i) => xL + i / (N - 1) * (xR - xL);
  const strip = (y0, h, title, vals, fmt, hi, color, errs) => {
    el('text', { x: 0, y: y0 + 10, fill: '#111', 'font-size': 11.5, 'font-weight': 500 }, sv).textContent = title;
    const lo = Math.min(...vals.map((v, i) => v - (errs ? errs : 0))), up = Math.max(...vals.map(v => v + (errs ? errs : 0)));
    const yy = (v) => up - lo > 1e-9 ? y0 + 18 + (up - v) / (up - lo) * (h - 22) : y0 + 18 + (h - 22) / 2;
    el('line', { x1: xL, x2: xR, y1: y0 + h - 4, y2: y0 + h - 4, stroke: C.grid }, sv);
    vals.forEach((v, i) => {
      const isH = i === hi;
      if (errs) el('line', { x1: xi(i), x2: xi(i), y1: yy(v + errs), y2: yy(v - errs), stroke: isH ? C.bb : 'rgba(30,50,57,.25)', 'stroke-width': 1 }, sv);
      const c = el('circle', { cx: xi(i), cy: yy(v), r: isH ? 4 : 2.2, fill: isH ? color : 'rgba(30,50,57,.55)' }, sv);
      c.addEventListener('mousemove', ev => showTip(`<b>xPU ${i}</b><br>${fmt(v)}${errs ? ` ± ${fmtEps(errs).slice(1)}` : ''}`, ev)); c.addEventListener('mouseleave', hideTip);
    });
    el('text', { x: xL - 6, y: yy(up) + 4, 'text-anchor': 'end', fill: C.axis, 'font-size': 10 }, sv).textContent = fmt(up);
    el('text', { x: xL - 6, y: yy(lo) + 4, 'text-anchor': 'end', fill: C.axis, 'font-size': 10 }, sv).textContent = fmt(lo);
  };
  const starts = Array.from(sHat, v => (v - med) / US);
  const col = new Array(N).fill(0); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) col[j] += st.T[i][j];
  const cm = X.median(col);
  strip(0, 84, 'Start time vs median (NIC PTP clock)', starts, v => `${v.toFixed(1)} µs`, r.h.straggler.who, C.orange, eps / US);
  strip(88, 84, 'Destination load vs median (switch counters)', col.map(v => (v / cm - 1) * 100), v => `${v.toFixed(1)}%`, r.h.incast.who, C.cool, 0);
  strip(176, 84, 'Port rate (link state)', Array.from(st.r, v => v / cfg.B * 100), v => `${v.toFixed(1)}%`, r.h.link.who, '#7b5ea7', 0);
}

// ---------- sweep ----------
function drawSweep() {
  const svg = $('sweep'); svg.innerHTML = '';
  const W = 620, H = 330, m = { l: 50, r: 16, t: 26, b: 52 };
  const lx = (e) => m.l + (Math.log2(e / X.GRID[0])) / (X.GRID.length - 1) * (W - m.l - m.r);
  const y = (p) => H - m.b - p * (H - m.t - m.b);
  for (const p of [0, .25, .5, .75, 1]) { el('line', { x1: m.l, x2: W - m.r, y1: y(p), y2: y(p), stroke: C.grid }, svg); el('text', { x: m.l - 7, y: y(p) + 4, 'text-anchor': 'end', fill: C.axis, 'font-size': 11 }, svg).textContent = Math.round(p * 100) + '%'; }
  X.GRID.forEach((e, k) => { if (k % 2 === 0) el('text', { x: lx(e), y: H - m.b + 16, 'text-anchor': 'middle', fill: C.axis, 'font-size': 10.5 }, svg).textContent = fmtEps(e).slice(1); });
  el('text', { x: (m.l + W - m.r) / 2, y: H - 14, 'text-anchor': 'middle', fill: C.axis, 'font-size': 11 }, svg).textContent = 'NIC clock error bound ε (log scale)';
  // ITU-T G.Suppl.92 classes for reference
  for (const [e, t] of [[50e-9, 'C'], [200e-9, 'B'], [2e-6, 'A']]) { el('line', { x1: lx(e), x2: lx(e), y1: m.t, y2: H - m.b, stroke: 'rgba(2,152,154,.25)', 'stroke-dasharray': '2 3' }, svg); el('text', { x: lx(e), y: m.t - 8, 'text-anchor': 'middle', fill: C.cool, 'font-size': 10 }, svg).textContent = `class ${t}`; }
  const cur = X.CLOCKS[clockIdx].eps;
  el('line', { x1: lx(cur), x2: lx(cur), y1: m.t, y2: H - m.b, stroke: C.bb, 'stroke-width': 1.4 }, svg);
  if (!grid) { $('sweepNote').textContent = ''; return; }
  const pts = grid.map(g => ({ e: g.eps, res: g.resolved / g.incidents, nw: g.naiveWrong / g.n, bw: g.boundWrong / g.n, ab: g.abstain / g.n }));
  const line = (key, col, dash, wdt = 2.2) => el('polyline', { points: pts.map(p => `${lx(p.e)},${y(p[key])}`).join(' '), fill: 'none', stroke: col, 'stroke-width': wdt, 'stroke-dasharray': dash || '' }, svg);
  line('ab', C.gray, '5 4', 1.8); line('nw', C.orange); line('bw', C.green); line('res', C.cool, '', 2.6);
  for (const p of pts) {
    for (const [key, col] of [['res', C.cool], ['nw', C.orange]]) {
      const c = el('circle', { cx: lx(p.e), cy: y(p[key]), r: 3.4, fill: '#fff', stroke: col, 'stroke-width': 1.6 }, svg);
      c.addEventListener('mousemove', ev => showTip(`<b>${fmtEps(p.e)}</b><br>Named with proof: ${(p.res * 100).toFixed(0)}% of incidents<br>Abstained: ${(p.ab * 100).toFixed(0)}% of steps<br>Bound-aware wrong: ${(p.bw * 100).toFixed(1)}%<br>Naive wrong: ${(p.nw * 100).toFixed(1)}%`, ev)); c.addEventListener('mouseleave', hideTip);
    }
  }
  const budget = X.budgetFromGrid(grid, 0.9);
  if (budget) { el('rect', { x: m.l, y: m.t, width: lx(budget) - m.l, height: H - m.t - m.b, fill: 'rgba(3,197,95,.06)' }, svg); el('text', { x: lx(budget) - 4, y: y(0.62), 'text-anchor': 'end', fill: '#018a43', 'font-size': 11 }, svg).textContent = `budget ${fmtEps(budget)}`; }
  $('sweepLegend').innerHTML = [['Named with proof (% of incidents)', C.cool, ''], ['Naive argmax wrong (% of steps)', C.orange, ''], ['Bound-aware wrong', C.green, ''], ['Abstained (% of steps)', C.gray, 'dashed']].map(([t, c, d]) => `<span><i class="ln" style="background:${d ? 'repeating-linear-gradient(90deg,' + c + ' 0 5px,transparent 5px 9px)' : c}"></i>${t}</span>`).join('');
  const at = (e) => grid.find(g => Math.abs(g.eps - e) / e < 1e-6);
  const g51 = at(51.2e-6), g3 = at(3.2e-6), g04 = at(0.4e-6);
  $('sweepSub').textContent = `${S.steps.length} steps replayed at ${grid.length} bounds`;
  $('sweepNote').innerHTML = `Bound-aware verdicts made <b>${grid.reduce((a, g) => a + g.boundWrong, 0)}</b> wrong calls across all ${grid.length} bounds. With ${fmtEps(0.4e-6)} clocks they name <b>${g04.resolved} of ${g04.incidents}</b> incidents; at ${fmtEps(3.2e-6)} still <b>${g3.resolved}</b>. With ${fmtEps(51.2e-6)} software-class clocks the naive method is wrong on <b>${g51.naiveWrong} of ${g51.n}</b> steps: it misses ${g51.naiveMissed} real faults because the clock noise in the start times swamps them, misblames ${g51.naiveMisblamed} and raises ${g51.naiveFalseAlarm} false alarm${g51.naiveFalseAlarm === 1 ? '' : 's'}.`;
}

function drawAll() { drawClock(); drawKpis(); drawDomain(); drawTable(); drawDetail(); drawSweep(); }
$('showTruth').addEventListener('change', e => { showTruth = e.target.checked; drawTable(); drawDetail(); });

// default selection: the slowest step that the current clock class names with proof
selected = R.rows.filter(r => ['straggler', 'incast', 'link'].includes(r.v.bound)).sort((a, b) => b.slow - a.slow)[3]?.k ?? 0;
drawAll();

// sweep across 13 bounds, one per task so the page stays responsive
const acc = []; let gi = 0;
function nextGrid() {
  if (gi >= X.GRID.length) { grid = acc; drawKpis(); drawSweep(); return; }
  const e = X.GRID[gi++]; acc.push({ eps: e, ...X.replay(S, e, truth).summary });
  $('sweepSub').textContent = `Replaying every step at 13 clock bounds… ${gi}/13`;
  setTimeout(nextGrid, 0);
}
setTimeout(nextGrid, 30);
