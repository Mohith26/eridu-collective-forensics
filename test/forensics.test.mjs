import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../core/forensics.mjs';

const S = X.generateSession();
const truth = S.steps.map(s => X.truthOf(s));

// brute-force fluid simulation with small time steps, for cross-checking the closed form
function bruteForce(T, s, r, dt) {
  const N = s.length; const rem = T.map(row => Float64Array.from(row)); const q = new Float64Array(N);
  const rowSum = T.map(row => row.reduce((a, b) => a + b, 0));
  let t = Math.min(...s), last = t;
  for (let it = 0; it < 2e6; it++) {
    let busy = false;
    for (let i = 0; i < N; i++) if (t >= s[i]) {
      const left = rem[i].reduce((a, b) => a + b, 0); if (left <= 1e-3) continue; busy = true;
      const send = Math.min(left, r[i] * dt);
      for (let j = 0; j < N; j++) { const x = send * T[i][j] / rowSum[i]; rem[i][j] -= x; q[j] += x; }
    } else busy = true;
    for (let j = 0; j < N; j++) if (q[j] > 1e-3) { busy = true; const d = Math.min(q[j], r[j] * dt); q[j] -= d; if (q[j] <= 1e-3) last = t + d / r[j]; }
    t += dt; if (!busy) break;
  }
  return last;
}

test('closed-form completion matches a brute-force fluid simulation', () => {
  const rand = X.mulberry32(3);
  for (let trial = 0; trial < 5; trial++) {
    const N = 5;
    const T = Array.from({ length: N }, () => Float64Array.from({ length: N }, () => 1e6 * (0.2 + rand())));
    const s = Float64Array.from({ length: N }, () => 1e-5 * rand());
    const r = Float64Array.from({ length: N }, () => 1e9 * (0.5 + rand()));
    const F = X.complete(T, s, r).F; const bf = bruteForce(T, s, r, 1e-7);
    assert.ok(Math.abs(F - bf) / F < 1e-3, `${F} vs ${bf}`);
  }
});

test('completion is non-decreasing and 1-Lipschitz in every start time', () => {
  const st = S.steps[5]; const F0 = X.complete(st.T, st.s, st.r).F; const rand = X.mulberry32(9);
  for (let k = 0; k < 40; k++) {
    const i = Math.floor(rand() * st.s.length), d = 50e-6 * rand();
    const s2 = Float64Array.from(st.s); s2[i] += d;
    const F1 = X.complete(st.T, s2, st.r).F;
    assert.ok(F1 >= F0 - 1e-15 && F1 - F0 <= d + 1e-15);
  }
});

test('every counterfactual interval contains the true-clock saving (the 2*eps guarantee)', () => {
  for (const eps of [200e-9, 2e-6, 20e-6, 200e-6]) for (const st of S.steps.slice(0, 80)) {
    const h = X.hypotheses(X.observe(st, S.offs, eps));
    const base = X.complete(st.T, st.s, st.r).F;
    // straggler with the same chosen sender, evaluated on true starts
    const s2 = Float64Array.from(st.s); s2[h.straggler.who] = X.median(st.s);
    const trueSt = base - X.complete(st.T, s2, st.r).F;
    assert.ok(Math.abs(h.straggler.gain - trueSt) <= 2 * eps + 1e-12);
    const hT = X.hypotheses({ T: st.T, sHat: st.s, r: st.r });
    assert.equal(hT.incast.who, h.incast.who); assert.equal(hT.link.who, h.link.who);
    assert.ok(Math.abs(h.incast.gain - hT.incast.gain) <= 2 * eps + 1e-12);
    assert.ok(Math.abs(h.link.gain - hT.link.gain) <= 2 * eps + 1e-12);
  }
});

test('bound-aware verdicts are never wrong across clock bounds and seeds', () => {
  for (const seed of [20261104, 7]) {
    const s = seed === 20261104 ? S : X.generateSession(seed);
    const tr = seed === 20261104 ? truth : s.steps.map(x => X.truthOf(x));
    for (const c of X.CLOCKS) assert.equal(X.replay(s, c.eps, tr).summary.boundWrong, 0, `${seed} ${c.label}`);
  }
});

test('tight clocks resolve nearly every incident; loose clocks make the naive method wrong', () => {
  const tight = X.replay(S, 200e-9, truth).summary, loose = X.replay(S, 200e-6, truth).summary;
  assert.ok(tight.resolved / tight.incidents > 0.95);
  assert.equal(tight.naiveWrong, 0);
  assert.ok(loose.naiveWrong / loose.n > 0.3);
  assert.equal(loose.answered, 0);
});

test('verdict logic: clear winner, overlap abstains, all-small is none', () => {
  const U = X.US, mk = (a, b, c) => ({ straggler: { gain: a * U }, incast: { gain: b * U }, link: { gain: c * U } });
  assert.equal(X.verdict(mk(60, 5, 0), 1e-6).bound, 'straggler');
  assert.equal(X.verdict(mk(60, 50, 0), 10e-6).bound, 'abstain');
  assert.equal(X.verdict(mk(60, 50, 0), 10e-6).naive, 'straggler');
  assert.equal(X.verdict(mk(3, 4, 2), 1e-6).bound, 'none');
  assert.equal(X.verdict(mk(18, 0, 0), 2e-6).bound, 'abstain');
});

test('sessions are deterministic per seed', () => {
  const b = X.generateSession();
  assert.equal(b.steps[17].s[3], S.steps[17].s[3]);
  assert.equal(b.steps[17].T[2][5], S.steps[17].T[2][5]);
  assert.notEqual(X.generateSession(1).steps[17].s[3], S.steps[17].s[3]);
});
