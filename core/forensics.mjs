// Collective Forensics core: fluid model of an MoE all-to-all on a single-hop scale-up switch, counterfactual
// attribution of slow collectives, and clock-error-bounded verdicts. Pure ES module (browser + node --test).

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// ---------- domain ----------
export const CFG = {
  N: 96,                  // xPUs in the slice (12 compute racks x 8)
  PER_RACK: 8,
  EXPERTS_PER_XPU: 2,
  TOP_K: 8,
  TOKENS: 4096,           // tokens per xPU per dispatch
  HIDDEN_BYTES: 7168,     // fp8 activations, 7168 hidden
  B: 200e9,               // bytes/s per xPU port and direction (1.6 Tb/s)
  JITTER_US: 1.0,         // natural start-time jitter (s.d.)
  STEPS: 300,
  THETA_US: 20,           // a cause must cost at least this much to be named
};
export const US = 1e-6;

// One dispatch all-to-all: T[i][j] bytes from xPU i to xPU j, per-xPU start times s (s), port rates r (bytes/s).
export function makeStep(rand, cfg = CFG, inject = null) {
  const { N, EXPERTS_PER_XPU: E, TOP_K, TOKENS, HIDDEN_BYTES, B } = cfg;
  const nE = N * E;
  // expert popularity: near-balanced (as after expert load balancing) with small per-step drift
  const pop = new Float64Array(nE);
  let ps = 0;
  for (let e = 0; e < nE; e++) { pop[e] = Math.exp(0.012 * gauss(rand)); ps += pop[e]; }
  const destShare = new Float64Array(N);
  for (let e = 0; e < nE; e++) destShare[Math.floor(e / E)] += pop[e] / ps;
  if (inject && inject.type === 'incast') { destShare[inject.who] *= inject.mag; }
  let ds = 0; for (let j = 0; j < N; j++) ds += destShare[j];
  for (let j = 0; j < N; j++) destShare[j] /= ds;
  const T = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < N; i++) {
    const tok = TOKENS * (1 + 0.004 * gauss(rand));
    const tot = tok * TOP_K * HIDDEN_BYTES;
    for (let j = 0; j < N; j++) T[i][j] = tot * destShare[j] * (1 + 0.01 * gauss(rand));
  }
  const s = new Float64Array(N), r = new Float64Array(N).fill(B);
  for (let i = 0; i < N; i++) s[i] = cfg.JITTER_US * US * gauss(rand);
  if (inject && inject.type === 'straggler') s[inject.who] += inject.mag * US;
  if (inject && inject.type === 'link') r[inject.who] = B * inject.mag;   // degraded lane set: both directions
  return { T, s, r };
}

// Exact fluid completion of the all-to-all on an output-queued single-hop switch.
// Sender i sprays its traffic over all destinations in proportion from s_i at rate r_i until done.
// Destination j drains at rate r_j. Last-bit departure (Reich): F_j = max_u [u + (A_j(inf) - A_j(u)) / r_j].
// Returns completion time F = max_j F_j and the per-destination finishes.
export function complete(T, s, r) {
  const N = s.length;
  const rowSum = new Float64Array(N), end = new Float64Array(N);
  for (let i = 0; i < N; i++) { let x = 0; for (let j = 0; j < N; j++) x += T[i][j]; rowSum[i] = x; end[i] = s[i] + x / r[i]; }
  // events common to every destination: each sender's ramp starts at s_i and ends at end_i
  const ev = [];
  for (let i = 0; i < N; i++) { ev.push([s[i], i, 1]); ev.push([end[i], i, -1]); }
  ev.sort((a, b) => a[0] - b[0]);
  const Fj = new Float64Array(N);
  let F = -Infinity, arg = 0;
  for (let j = 0; j < N; j++) {
    let A = 0, slope = 0, t = ev[0][0], tot = 0;
    for (let i = 0; i < N; i++) tot += T[i][j];
    let best = -Infinity;
    for (const [te, i, k] of ev) {
      A += slope * (te - t); t = te;
      const v = te + (tot - A) / r[j];
      if (v > best) best = v;
      slope += k * r[i] * T[i][j] / rowSum[i];
    }
    Fj[j] = best;
    if (best > F) { F = best; arg = j; }
  }
  return { F, Fj, critical: arg };
}

export function median(a) { const b = Array.from(a).sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }

// ---------- counterfactual attribution ----------
// Hypotheses are evaluated on what the fabric can observe: start times from each NIC's PTP hardware clock (each off by
// at most eps), byte counters and port rates from the switch (exact). F is non-decreasing and 1-Lipschitz in every start
// time under this model, so every counterfactual saving computed from measured starts is within +-2*eps of the saving
// computed from the true starts. That turns each estimate into a guaranteed interval.
export const CAUSES = ['straggler', 'incast', 'link'];
export function hypotheses(obs, cfg = CFG) {
  const { T, sHat, r } = obs;
  const N = sHat.length;
  const base = complete(T, sHat, r).F;
  const med = median(sHat);
  // straggler: re-time the latest-measured senders to the median start
  const order = Array.from(sHat.keys()).sort((a, b) => sHat[b] - sHat[a]).slice(0, 3);
  let st = { gain: 0, who: order[0] };
  for (const i of order) {
    const s2 = Float64Array.from(sHat); s2[i] = med;
    const g = base - complete(T, s2, r).F;
    if (g > st.gain) st = { gain: g, who: i };
  }
  // incast: rebalance the heaviest destination column to the median column load
  const col = new Float64Array(N); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) col[j] += T[i][j];
  let jHot = 0; for (let j = 1; j < N; j++) if (col[j] > col[jHot]) jHot = j;
  const cMed = median(col);
  const T2 = T.map(row => Float64Array.from(row));
  for (let i = 0; i < N; i++) T2[i][jHot] *= cMed / col[jHot];
  const inc = { gain: base - complete(T2, sHat, r).F, who: jHot };
  // link: restore the slowest port to nominal rate
  let kSlow = 0; for (let k = 1; k < N; k++) if (r[k] < r[kSlow]) kSlow = k;
  const r2 = Float64Array.from(r); r2[kSlow] = cfg.B;
  const lnk = { gain: base - complete(T, sHat, r2).F, who: kSlow };
  return { base, straggler: st, incast: inc, link: lnk };
}

// Verdicts. Naive: the largest point estimate wins. Bound-aware: a cause is named only when its whole interval clears the
// threshold and beats every other interval; "none" only when every upper bound is below threshold; otherwise abstain.
export function verdict(h, eps, cfg = CFG) {
  const th = cfg.THETA_US * US, w = 2 * eps;
  const g = CAUSES.map(c => h[c].gain);
  const k = g.indexOf(Math.max(...g));
  const naive = g[k] >= th ? CAUSES[k] : 'none';
  let bound;
  if (g.every(x => x + w < th)) bound = 'none';
  else if (g[k] - w >= th && g.every((x, m) => m === k || g[k] - w > x + w)) bound = CAUSES[k];
  else bound = 'abstain';
  return { naive, bound, intervals: g.map(x => [x - w, x + w]), k };
}

// ---------- scenario: a session of dispatch steps with injected incidents ----------
export const CLOCKS = [
  { id: 'C', label: '±50 ns', eps: 50e-9, note: 'PPS-disciplined (ITU class C)' },
  { id: 'B', label: '±200 ns', eps: 200e-9, note: 'PTP with PTM (class B)' },
  { id: 'A', label: '±2 µs', eps: 2e-6, note: 'PTP without PTM (class A)' },
  { id: 'SW', label: '±20 µs', eps: 20e-6, note: 'Software clock sync' },
  { id: 'NTP', label: '±200 µs', eps: 200e-6, note: 'NTP-class' },
];

export function generateSession(seed = 20261104, cfg = CFG) {
  const rand = mulberry32(seed);
  const steps = [];
  for (let k = 0; k < cfg.STEPS; k++) {
    const u = rand();
    let inject = null;
    const who = Math.floor(rand() * cfg.N);
    if (u < 0.22) inject = { type: 'straggler', who, mag: 6 + 90 * rand() };                 // µs late
    else if (u < 0.44) inject = { type: 'incast', who, mag: 1.02 + 0.10 * rand() };         // hot expert
    else if (u < 0.62) inject = { type: 'link', who, mag: 0.93 + 0.06 * rand() };           // degraded lanes
    const st = makeStep(rand, cfg, inject);
    steps.push({ k, inject, ...st });
  }
  // fixed per-NIC clock offset pattern in [-1, 1], scaled by each clock class's bound
  const offs = new Float64Array(cfg.N); for (let i = 0; i < cfg.N; i++) offs[i] = 2 * rand() - 1;
  // nominal completion: balanced traffic, no jitter
  const nominal = (cfg.TOKENS * cfg.TOP_K * cfg.HIDDEN_BYTES) / cfg.B;
  return { seed, cfg, steps, offs, nominal };
}

// Ground truth for a step: which injected cause actually cost >= THETA (true-start counterfactuals).
export function truthOf(step, cfg = CFG) {
  const h = hypotheses({ T: step.T, sHat: step.s, r: step.r }, cfg);
  const th = cfg.THETA_US * US;
  const inj = step.inject ? step.inject.type : 'none';
  const cost = inj === 'none' ? 0 : h[inj].gain;
  return { label: inj !== 'none' && cost >= th ? inj : (inj === 'none' ? 'none' : 'minor'), cost, h };
}

export function observe(step, offs, eps) {
  const sHat = Float64Array.from(step.s, (x, i) => x + offs[i] * eps);
  return { T: step.T, sHat, r: step.r };
}

// Replay a session under one clock class.
export function replay(session, eps, truth = null) {
  const { steps, offs, cfg } = session;
  const tr = truth ?? steps.map(s => truthOf(s, cfg));
  const rows = steps.map((st, k) => {
    const o = observe(st, offs, eps);
    const h = hypotheses(o, cfg);
    const v = verdict(h, eps, cfg);
    const F = complete(st.T, st.s, st.r).F;
    const culprit = v.bound === 'straggler' ? h.straggler.who : v.bound === 'incast' ? h.incast.who : v.bound === 'link' ? h.link.who : null;
    const naiveWho = v.naive === 'straggler' ? h.straggler.who : v.naive === 'incast' ? h.incast.who : v.naive === 'link' ? h.link.who : null;
    return { k, F, slow: (F - session.nominal) / US, truth: tr[k], h, v, culprit, naiveWho, inject: st.inject };
  });
  return { eps, rows, summary: score(rows) };
}

// Scoring on steps whose truth is a definite label (cause costing >= THETA, or clean). 'minor' injections are excluded.
export function score(rows) {
  const ev = rows.filter(r => r.truth.label !== 'minor');
  const right = (lab, who, r) => lab === r.truth.label && (lab === 'none' || who === r.inject.who);
  const naiveWrong = ev.filter(r => !right(r.v.naive, r.naiveWho, r)).length;
  const answered = ev.filter(r => r.v.bound !== 'abstain');
  const boundWrong = answered.filter(r => !right(r.v.bound, r.culprit, r)).length;
  const incidents = ev.filter(r => r.truth.label !== 'none');
  const nw = ev.filter(r => !right(r.v.naive, r.naiveWho, r));
  return {
    naiveMissed: nw.filter(r => r.v.naive === 'none').length,
    naiveMisblamed: nw.filter(r => r.v.naive !== 'none' && r.truth.label !== 'none').length,
    naiveFalseAlarm: nw.filter(r => r.v.naive !== 'none' && r.truth.label === 'none').length,
    n: ev.length, incidents: incidents.length,
    naiveWrong, naiveAcc: 1 - naiveWrong / ev.length,
    answered: answered.length, boundWrong, abstain: ev.length - answered.length,
    resolved: incidents.filter(r => right(r.v.bound, r.culprit, r)).length,
  };
}

// Clock-bound grid used by the sweep: 50 ns doubling to 204.8 us.
export const GRID = Array.from({ length: 13 }, (_, k) => 50e-9 * 2 ** k);
// Largest grid bound that still resolves at least `target` of real incidents with zero wrong calls.
export function budgetFromGrid(grid, target = 0.9) {
  let best = null;
  for (const g of grid) if (g.boundWrong === 0 && g.resolved / g.incidents >= target) best = g.eps;
  return best;
}
