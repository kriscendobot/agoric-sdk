// probe-raw.mjs — raw native non-tail recursion-depth probe (no Endo).
//
// Reconstructed from the investigation report of
// `investigate-beta3-ymax0-xs-repro-and-fix` (original at
// /home/kris/agoric-sdk/scratch-xs-repro/probe-raw.mjs, GC'd).
//
// Purpose: establish the engine's *baseline* native stack budget — the number of
// non-tail frames it can nest before overflow — independent of any Endo code, so
// the passStyleOf/marshal/mustMatch limits in probe-v8.mjs can be converted into
// "frames per nesting level" (~3 for passStyleOf, ~23 for checkMatches).
//
// Run under Node/V8:  node probe-raw.mjs
// The same body is evaluated inside an xsnap worker by scratch-xs-depth.mjs to
// obtain the XS budget.
//
// Measured:
//   XS native non-tail budget ≈ 350 frames (XS does proper tail-call elimination,
//     so only genuine non-tail frames count).
//   V8 is ~15–30× deeper on this host.

// A guaranteed non-tail recursion: the `1 +` keeps the caller's frame live.
const recur = d => (d <= 0 ? 0 : 1 + recur(d - 1));

// Also exercise the structural walk the rehydration paths actually do: build a
// right-nested plain object and walk it recursively (matches the "nested-record
// walk" that bottoms out at the same ~350 frames in XS).
const mkRec = d => {
  let n = { leaf: 'end' };
  for (let i = 0; i < d; i++) n = { x: n };
  return n;
};
const walk = node => ('x' in node ? 1 + walk(node.x) : 0);

const probe = (label, fn) => {
  let lo = 1, hi = 1;
  for (;;) { try { fn(hi); lo = hi; hi *= 2; if (hi > 4_000_000) break; } catch { break; } }
  let bad = hi;
  while (lo + 1 < bad) { const mid = (lo + bad) >> 1; try { fn(mid); lo = mid; } catch { bad = mid; } }
  console.log(`${label}: max survivable depth = ${lo}`);
  return lo;
};

probe('raw non-tail recursion', recur);
probe('nested-record walk', d => walk(mkRec(d)));
