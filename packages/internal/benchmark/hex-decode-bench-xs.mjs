/* eslint-disable no-bitwise */
/**
 * XS (xsnap) runner for the hex-decode benchmark.
 *
 * Drives an XS worker via `@agoric/xsnap`'s `xsnap()` export, feeds it the
 * identical engine-agnostic core used by the Node runner, then for each
 * approach and input reports BOTH the XS wall-clock per decode AND the XS
 * metered `compute` per decode. On the consensus engine the metered cost, not
 * wall-clock, is what a contract pays, so it is the number that decides whether
 * the 484-entry Map accelerator earns its keep.
 *
 * The worker is the real `@agoric/xsnap` worker: `xsnap()` resolves the
 * prebuilt `xsnap-worker` from the installed package, speaks its netstring
 * protocol, and surfaces the per-evaluate `meterUsage` — so this script no
 * longer recapitulates worker-path resolution or the fd-3/fd-4 framing. Set
 * XSNAP_WORKER to override the worker binary (honored by `@agoric/xsnap`
 * itself). NOTE: many sandboxes mount /tmp noexec, so an overriding
 * XSNAP_WORKER should point at an exec-capable location (for example under
 * ~/.cache).
 *
 * Run: node packages/internal/benchmark/hex-decode-bench-xs.mjs
 *   or: XSNAP_WORKER=/path/to/xsnap-worker \
 *        node packages/internal/benchmark/hex-decode-bench-xs.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type as osType } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const coreSrc = readFileSync(`${here}hex-decode-bench-core.js`, 'utf8');

const SIZES = [
  { name: 'short', bytes: 8, iters: 4000 },
  { name: 'medium', bytes: 1024, iters: 400 },
  { name: 'large', bytes: 16384, iters: 40 },
];
const MODES = ['lower', 'upper', 'mixed'];
const SEED = 0x1234abcd;

// Dynamic import to avoid static module dependency cycles. `xsnap()` resolves
// the prebuilt worker from the installed @agoric/xsnap and speaks its protocol;
// each evaluate returns a `meterUsage` and rejects on an uncaught XS exception,
// so an inner `throw` IS the failure signal (no separate ok flag needed).
const w = await (await import('@agoric/xsnap')).xsnap({
  name: 'hex-decode-benchmark-xs-worker',
  meteringLimit: 2_000_000_000,
  // @ts-expect-error not providing filesystem access
  fs: {},
  os: osType(),
  spawn,
});

// Table build cost: the metered compute of evaluating the core (which builds
// the 484-entry Map accelerator at module scope).
const buildRes = await w.evaluate(coreSrc);
const tableBuildCompute = buildRes.meterUsage
  ? buildRes.meterUsage.compute
  : null;
// xsnap's `e` reply carries the meter but not the completion value, so confirm
// the table size by asserting inside XS (throws -> reject if it is not 484).
await w.evaluate(
  'if (hexbench.tableSize !== 484) throw Error("table size " + hexbench.tableSize)',
);
const tableSize = 484;

// Build + correctness-check every corpus before timing. checkCorrectness
// throws inside XS on any mismatch, so a resolved evaluate IS the pass signal.
for (const { name, bytes } of SIZES) {
  for (const mode of MODES) {
    const key = `${name}-${mode}`;
    await w.evaluate(
      `hexbench.makeCorpus(${JSON.stringify(key)}, ${bytes}, ${JSON.stringify(mode)}, ${SEED})`,
    );
    await w.evaluate(
      `hexbench.checkCorrectness(${JSON.stringify(key)}, ${bytes}, ${SEED})`,
    );
  }
}

// Measure one (approach,key) cell: median-ish wall over a few reps plus the
// deterministic metered compute, both for the requested approach and the
// 'empty' loop baseline so loop/call overhead is subtracted out.
const measure = async (approach, key, iters) => {
  const call = `hexbench.decodeLoop(${JSON.stringify(approach)}, ${JSON.stringify(key)}, ${iters})`;
  // warmup
  await w.evaluate(call);
  let bestWall = Infinity;
  let compute = null;
  for (let rep = 0; rep < 4; rep += 1) {
    const t0 = process.hrtime.bigint();
    const r = await w.evaluate(call);
    const dt = Number(process.hrtime.bigint() - t0);
    bestWall = Math.min(bestWall, dt);
    if (r.meterUsage) compute = r.meterUsage.compute;
  }
  return { wall: bestWall, compute };
};

const results = [];
for (const { name, bytes, iters } of SIZES) {
  for (const mode of MODES) {
    const key = `${name}-${mode}`;
    const base = await measure('empty', key, iters);
    for (const approach of ['map', 'arith', 'lut']) {
      const m = await measure(approach, key, iters);
      const wallPerOp = (m.wall - base.wall) / iters;
      const computePerOp =
        m.compute != null && base.compute != null
          ? (m.compute - base.compute) / iters
          : null;
      results.push({
        size: name,
        bytes,
        mode,
        approach,
        iters,
        wallPerOpNs: wallPerOp,
        computePerOp,
        computeTotal: m.compute,
      });
    }
  }
}

await w.close();

// --- Report ------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const find = (size, mode, approach) =>
  results.find(
    r => r.size === size && r.mode === mode && r.approach === approach,
  );

// eslint-disable-next-line no-console
console.log(
  `# XS (xsnap) hex decode\nworker: @agoric/xsnap xsnap()\ntable: ${tableSize}-entry Map\n`,
);
// eslint-disable-next-line no-console
console.log(`# Table build cost (one-time, at module instantiation)`);
// eslint-disable-next-line no-console
console.log(
  `  metered compute to build the 484-entry Map accelerator: ${tableBuildCompute}\n`,
);

const APPROACHES = ['map', 'arith', 'lut'];
const head = `${pad('size', 8)}${pad('mode', 7)}${APPROACHES.map(a => pad(a, 12)).join('')}${pad('map/arith', 10)}`;

// eslint-disable-next-line no-console
console.log('# XS metered compute per decode (lower is better)\n');
// eslint-disable-next-line no-console
console.log(head);
for (const { name } of SIZES) {
  for (const mode of MODES) {
    const cells = APPROACHES.map(a =>
      pad(find(name, mode, a).computePerOp.toFixed(0), 12),
    ).join('');
    const ratio =
      find(name, mode, 'map').computePerOp /
      find(name, mode, 'arith').computePerOp;
    // eslint-disable-next-line no-console
    console.log(
      `${pad(name, 8)}${pad(mode, 7)}${cells}${pad(`${ratio.toFixed(2)}x`, 10)}`,
    );
  }
}

// eslint-disable-next-line no-console
console.log('\n# XS wall-clock per decode, ns (lower is better)\n');
// eslint-disable-next-line no-console
console.log(head);
for (const { name } of SIZES) {
  for (const mode of MODES) {
    const cells = APPROACHES.map(a =>
      pad(find(name, mode, a).wallPerOpNs.toFixed(0), 12),
    ).join('');
    const ratio =
      find(name, mode, 'map').wallPerOpNs /
      find(name, mode, 'arith').wallPerOpNs;
    // eslint-disable-next-line no-console
    console.log(
      `${pad(name, 8)}${pad(mode, 7)}${cells}${pad(`${ratio.toFixed(2)}x`, 10)}`,
    );
  }
}

// eslint-disable-next-line no-console
console.log(
  `\n#JSON ${JSON.stringify({ engine: 'xs', worker: '@agoric/xsnap', tableSize, tableBuildCompute, results })}`,
);
