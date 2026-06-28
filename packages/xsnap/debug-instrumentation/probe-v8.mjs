// probe-v8.mjs — V8 stack-depth probe for the rehydration entry paths.
//
// Reconstructed from the investigation report of
// `investigate-beta3-ymax0-xs-repro-and-fix` (the original scratch tree at
// /home/kris/agoric-sdk/scratch-xs-repro/probe-v8.mjs was GC'd; this is a
// faithful reconstruction of the same binary-search probe, identical in shape
// to the surviving bisection probe in ./endo-bisection/probe.mjs).
//
// Run under Node/V8:  node probe-v8.mjs
// It resolves whatever @endo/* is installed in the surrounding workspace, so in
// the agoric-sdk tree it measures the repo's actual Endo 2.x ("beta3") budget.
//
// Measured on host endolinbot (V8):
//   passStyleOf         max survivable depth ≈ 2047
//   marshal round-trip  max survivable depth ≈ 1790
//   mustMatch           max survivable depth ≈ 511
// (Compare ./scratch-xs-depth.mjs for the XS budget, ~15–30× shallower.)

import '@endo/init/debug.js';
import { passStyleOf } from '@endo/pass-style';
import { makeMarshal } from '@endo/marshal';
import { M, mustMatch } from '@endo/patterns';

const { toCapData, fromCapData } = makeMarshal(undefined, undefined, {
  serializeBodyFormat: 'smallcaps',
});

// A right-nested record { x: { x: { ... leaf } } } of depth d.
const mkRec = d => {
  let n = harden({ leaf: 'end' });
  for (let i = 0; i < d; i++) n = harden({ x: n });
  return n;
};
// A matching splitRecord pattern of depth d.
const mkPat = d => {
  let p = M.any();
  for (let i = 0; i < d; i++) p = M.splitRecord({ x: p });
  return harden(p);
};

// Exponential-then-binary search for the deepest structure fn() survives.
const probe = (label, fn) => {
  let lo = 1, hi = 1;
  for (;;) { try { fn(hi); lo = hi; hi *= 2; if (hi > 2_000_000) break; } catch { break; } }
  let bad = hi;
  while (lo + 1 < bad) { const mid = (lo + bad) >> 1; try { fn(mid); lo = mid; } catch { bad = mid; } }
  console.log(`${label}: max survivable V8 depth = ${lo}`);
  return lo;
};

probe('passStyleOf', d => passStyleOf(mkRec(d)));
probe('marshal round-trip', d => fromCapData(toCapData(mkRec(d))));
probe('mustMatch', d => mustMatch(mkRec(d), mkPat(d)));
