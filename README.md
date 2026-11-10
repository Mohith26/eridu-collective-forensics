# Collective Forensics for Eridu scale-up fabrics (concept)

**Live demo:** https://mohith26.github.io/eridu-collective-forensics/

An unofficial concept for a fabric-manager feature: when an MoE all-to-all in a single-hop scale-up domain runs slow,
name the xPU, port or hot expert that cost the time, and **prove it** with intervals derived from each NIC clock's
PTP error bound. When the clocks are too loose to tell, it says so instead of guessing.

Built by Mohith Gajjela. Not affiliated with Eridu. All data is synthetic.

## Why this feature

Eridu is building single-hop scale-up domains with hundreds to thousands of xPUs across disaggregated racks. In a domain
that size, a slow collective stalls every xPU in it, and the first question is "whose fault was it". Three very different
fixes hide behind the same symptom: a late sender (compute straggler), a hot expert pulling too many tokens to one port
(incast), or a degraded port. Telling them apart needs start times from different NICs on one time base, which is exactly
what the OCP Time Appliances Project's datacenter PTP work is about. The OCP TAP white paper *Time Synchronization in AI
Distributed Infrastructure* (v0.9.1, Oct 2026) lists principled uncertainty bounds for timestamp-based root-cause analysis
and "matching the synchronization method to the attribution-error budget" as open problems. This demo is one concrete
answer: attribution that carries the clock error bound all the way into the verdict, plus a measured clock-error budget.

## How it works

All logic is in `core/forensics.mjs` (pure ES module, no dependencies).

1. **Fluid model of one dispatch all-to-all.** 96 xPUs (12 compute racks of 8, one hop through the switch), 1.6 Tb/s per
   port and direction. Each xPU sprays its 235 MB of fp8 activations (4,096 tokens × top-8 × 7,168 B) across all
   destinations from its start time. Destination ports drain at line rate. Completion is computed exactly with the
   last-bit departure formula for a work-conserving queue (Reich): F_j = max_u [u + (A_j(∞) − A_j(u)) / r_j], evaluated at
   the breakpoints of the piecewise-linear arrival curve, O(N²) per step.
2. **Counterfactuals.** For each step: re-time the three latest-measured senders to the median start; rebalance the
   heaviest destination column to the median load; restore the slowest port to line rate. Each "saving" is how much
   sooner the collective would have finished.
3. **Clock-error intervals.** Completion is non-decreasing and 1-Lipschitz in every start time under this model, so if
   every NIC clock is within ±ε of true time, each saving computed from measured starts is within ±2ε of the saving
   computed from true starts. Byte counters and port rates come from the switch and carry no clock error. No
   distributional assumption is needed.
4. **Verdict.** Name a cause only if its lower bound clears 20 µs and exceeds every other hypothesis's upper bound;
   say "no fault" only if every upper bound is under 20 µs; otherwise abstain. The naive baseline just takes the largest
   point estimate.
5. **Clock-error budget.** Replay all 300 steps at 13 bounds (50 ns doubling to 205 µs) and report the loosest bound
   that still names at least 90% of real incidents with zero wrong calls.

## Results on the committed seed

Reproduce with `node scripts/summary.mjs` (writes `data/summary.json`). The page computes the same numbers live.

- 300 dispatch steps; 112 real incidents (a fault costing ≥ 20 µs), 107 clean steps, 81 minor injections excluded from scoring.
- Bound-aware verdicts: **0 wrong calls at every bound** from 50 ns to 205 µs.
- Named with proof: 110 of 112 incidents at ±50-400 ns, 109 at ±0.8-1.6 µs, 102 at ±3.2 µs, 90 at ±6.4 µs, 55 at ±12.8 µs.
- Clock-error budget for 90% coverage: **±3.2 µs** (ITU-T G.Suppl.92 class A, PTP without PTM, clears it; software sync does not).
- Naive argmax at ±51 µs (software-sync class): wrong on 59 of 219 scored steps, 58 of them by **missing** a real fault,
  because clock noise in the start times swamps the counterfactuals. At ±205 µs it is wrong on 112 of 219.
- Same pattern on seeds 7 and 8 (bound-aware 0 wrong; about 80% named at ±6.4 µs).

## Tests

```
node --test
```

7 tests: closed-form completion matches a brute-force time-stepped fluid simulation; completion is monotone and
1-Lipschitz in start times; every interval contains the true-clock saving across 4 clock bounds (the ±2ε guarantee);
bound-aware verdicts are never wrong across clock classes and two seeds; tight clocks resolve > 95% while loose clocks
break the naive method; verdict logic edge cases; deterministic seeding.

## Honest limitations

- **Fluid, output-queued model.** No finite buffers, PFC or credit backpressure, no packet-level effects, no multi-plane
  spraying. Real incast with shallow buffers spreads delay to other ports, which this model does not capture; the
  Lipschitz guarantee would need re-deriving for a backpressured fabric.
- Faults are injected one at a time; overlapping causes would make more steps abstain.
- The counterfactual set is three hypotheses, not a full search over every xPU and port.
- The guarantee covers clock offsets inside the stated bound. If a clock silently violates its bound (a bad grandmaster,
  holdover drift), the intervals are wrong; that is the case for exporting an error bound alongside time (OCP TAP time API).
- 96 xPUs, not thousands, to keep the in-browser replay fast. Cost is O(N²) per counterfactual.
- Eridu has no public software UI. The shell is my rebuild of the eridu.ai design system (Montserrat, blueblack header,
  green-to-teal title band, 1rem cards, colors from the site's theme CSS).

## Novelty note

Eridu has not announced fabric-management or telemetry software (site, press release, articles, careers as of Nov 2026).
Related work exists and is cited honestly: straggler what-if analysis from host traces (OSDI '25 "Understanding Stragglers
in Large Model Training Using What-if Analysis"), cross-rank straggler detection (SysOM-AI, KAIR), software clock sync for
NCCL timelines (Clockwork), and incast-avoiding all-to-all scheduling (FAST, NSDI '26). None of these carries a clock error
bound into a certified verdict or measures the clock budget attribution needs; the OCP TAP white paper names that as open.

## Files

- `index.html`, `assets/style.css`, `assets/app.js`: single-page fabric-manager view (Google Fonts only, no build step)
- `core/forensics.mjs`: fluid model, counterfactuals, interval verdicts, replay, clock-budget sweep
- `test/forensics.test.mjs`: unit tests
- `scripts/summary.mjs`: seeded regeneration of the headline numbers
