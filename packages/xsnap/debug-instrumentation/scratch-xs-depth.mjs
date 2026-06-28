// scratch-xs-depth.mjs — XS (xsnap) native stack-depth probe. CORE INSTRUMENTATION.
//
// Reconstructed from the investigation report of
// `investigate-beta3-ymax0-xs-repro-and-fix` (original at
// /home/kris/agoric-sdk/packages/xsnap/scratch-xs-depth.mjs, GC'd). Run from the
// built packages/xsnap workspace (see ../debug-instrumentation/README.md for the
// build workaround that yields a runnable xsnap-worker on this host class).
//
// Why a fresh worker per trial: in XS a stack overflow is UNCATCHABLE — it does
// not throw a JS error, it aborts the whole worker ("exited: stack overflow").
// That is exactly the production v320 signature (the slog has no error entry; the
// vat simply dies mid-rehydration). So we cannot try/catch inside one worker; we
// spawn a fresh worker for each candidate depth and treat worker-death as "too
// deep", then binary-search the boundary.
//
// The evaluated body mirrors ./endo-bisection/probe-entry.js — passStyleOf /
// marshal round-trip / mustMatch over a right-nested record of depth d — so the
// XS result is apples-to-apples with the V8 result from ./probe-v8.mjs.
//
// Measured on host endolinbot (xsnap-worker XS v0.14.2):
//   XS native non-tail budget ≈ 350 frames
//   passStyleOf        ≈ 115–127 levels   (~3 frames/level)
//   marshal round-trip ≈ 110 levels
//   mustMatch / checkMatches ≈ 15 levels  (~23 frames/level)  ← the binding limit
// vs V8 on the same host: 2047 / 1790 / 511. XS is ~15–30× shallower, which is
// why a structure that round-trips fine under a V8 test vat aborts a real XS vat.

import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import bundleSource from '@endo/bundle-source';
import { xsnap } from '@agoric/xsnap';

const xsnapOptions = { os: os.type(), spawn, fs, stdout: 'inherit', stderr: 'inherit' };

// Bundle the in-XS probe (endoScript: a single evaluable script for xsnap.evaluate).
const probeBundle = await bundleSource(
  new URL('./endo-bisection/probe-entry.js', import.meta.url).pathname,
  { format: 'endoScript' },
);
const initBundle = await bundleSource(
  new URL('./endo-bisection/init-entry.js', import.meta.url).pathname,
  { format: 'endoScript' },
);

// Run ONE trial in a FRESH worker. Resolves true if the worker survived calling
// `method` at depth d, false if it died (stack overflow or any abort).
const trial = async (method, d) => {
  const worker = xsnap({ ...xsnapOptions, name: `xs-depth-${method}-${d}` });
  try {
    await worker.evaluate(initBundle.source);
    await worker.evaluate(probeBundle.source);
    // The probe module hangs its exports off globalThis under endoScript; call the
    // chosen method at depth d. If it overflows, evaluate() rejects with the
    // worker's "exited: stack overflow" and we fall to the catch.
    await worker.evaluate(`${method}(${d});`);
    await worker.close();
    return true;
  } catch (err) {
    try { await worker.terminate(); } catch {}
    // Distinguish a genuine depth failure from a setup error.
    if (!/stack ?overflow|exited|terminated/i.test(String(err && err.message))) {
      console.error(`unexpected (not an overflow): ${err && err.message}`);
    }
    return false;
  }
};

// Exponential-then-binary search for the deepest depth the worker survives.
const probe = async (method, label) => {
  let lo = 0, hi = 1;
  while (await trial(method, hi)) { lo = hi; hi *= 2; if (hi > 100_000) break; }
  let bad = hi;
  while (lo + 1 < bad) {
    const mid = (lo + bad) >> 1;
    if (await trial(method, mid)) lo = mid; else bad = mid;
  }
  console.log(`${label}: max survivable XS depth = ${lo}`);
  return lo;
};

await probe('passStyle', 'passStyleOf');
await probe('marshalRT', 'marshal round-trip');
await probe('matchD', 'mustMatch / checkMatches');
