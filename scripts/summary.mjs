// Regenerates the seeded session and prints/writes the numbers the page computes live.  node scripts/summary.mjs [seed]
import { writeFileSync } from 'node:fs';
import * as X from '../core/forensics.mjs';
const seed = Number(process.argv[2] ?? 20261104);
const S = X.generateSession(seed);
const truth = S.steps.map(s => X.truthOf(s));
const labels = {}; truth.forEach(t => labels[t.label] = (labels[t.label] || 0) + 1);
const grid = X.GRID.map(eps => ({ eps, ...X.replay(S, eps, truth).summary }));
const budget = X.budgetFromGrid(grid, 0.9);
const out = { seed, cfg: S.cfg, nominal_us: S.nominal / X.US, labels, grid, budget90_eps: budget };
writeFileSync(new URL('../data/summary.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ labels, budget90_us: budget && budget * 1e6, grid: grid.map(g => `${(g.eps * 1e6).toFixed(2)}us naiveWrong=${g.naiveWrong} boundWrong=${g.boundWrong} resolved=${g.resolved}/${g.incidents} abstain=${g.abstain}`) }, null, 1));
