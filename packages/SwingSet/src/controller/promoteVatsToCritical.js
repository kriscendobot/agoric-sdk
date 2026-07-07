import { Fail, q } from '@endo/errors';

/**
 * @import {SwingStoreKernelStorage} from '../types-external.js';
 */

/**
 * PROTOTYPE (kriskowal/garden#29): promote already-running vats to `critical`
 * at chain-software-upgrade time, without upgrading vat-vat-admin.
 *
 * Background. A vat's `critical` flag is a plain boolean persisted in the vat's
 * options blob at the consensus kvStore key `${vatID}.options`. It is written
 * once at `createVat` (guarded by the unforgeable `criticalVatKey` at the
 * vat-admin layer, which `convertOptions` reduces to a boolean) and is read
 * exactly once per termination, in `kernel.js` `terminateVat()`:
 * `critical = vatKeeper.getOptions().critical; ... if (critical) panic(...)`.
 * There is no supported run-time API to promote a running vat: `upgradeVat`
 * spreads the old options and preserves `critical`; `changeVatOptions` /
 * vat-admin `changeOptions` accept only `reapInterval` and throw on any other
 * key. So the only lever that can flip the bit on a live vat is kernel-side
 * host code rewriting `${vatID}.options` — exactly the read-modify-write that
 * `vatKeeper.setReapDirtThreshold()` and the `upgradeSwingset()` migrations
 * already perform, and that `misc-tools/db-set.js` exposes as a raw tool.
 *
 * This helper is that lever, factored as a pure, testable function. It is meant
 * to run at reboot time, from the host, right where `upgradeSwingset()` runs —
 * i.e. after `ensureSwingsetInitialized()` and BEFORE `makeSwingsetController()`
 * (see `packages/cosmic-swingset/src/launch-chain.js`). Running there means the
 * promoted value is picked up cleanly when the vat warehouse is first built, so
 * no vat restart / new incarnation is involved. The write MUST be deterministic
 * and identical on every validator (it lands on a consensus key and folds into
 * the activityhash), which it is: it is baked into the released SwingSet binary
 * and gated by the chain-software upgrade, the same trust basis as every other
 * `upgradeSwingset` migration.
 *
 * Chain-specificity. Real agoric upgrades already gate per chain — e.g.
 * `golang/cosmos/app/upgrade.go` builds vat-termination targets under a
 * `switch ctx.ChainID()` (commit 3658973b8e deliberately moved from
 * upgrade-name gating to chain-id gating). Two ways to express that here:
 *
 *   1. chainID mode: pass `chainID` and let `promotionsByChain` select the
 *      per-chain target list (pins the exact vatID per chain, e.g. agoric-3 ->
 *      v288/ymax1, agoricdev-25 -> v320/ymax0). NOTE: at the `upgradeSwingset`
 *      call site the cosmos `chainID` is NOT yet available (it arrives later
 *      with the `AG_COSMOS_INIT` action, by which time the controller is
 *      already built and raw kvStore surgery is unsafe). Using this mode
 *      therefore requires plumbing `chainID` to process startup (e.g. an env
 *      var / CLI arg from the golang daemon).
 *
 *   2. label mode: pass `targets` (a list of `{ name }` specs) and skip the
 *      chainID gate entirely. Discovery is by vat label, matching the a3p
 *      `getDetailsMatchingVats(name)` convention (`vatName.endsWith(name)`).
 *      This is self-chain-gating — only agoric-3 carries a vat labelled
 *      `ymax1` and only agoricdev-25 carries one labelled `ymax0` — and needs
 *      no new plumbing, so it is the recommended first cut for a prototype.
 *
 * The function is idempotent: a vat already `critical` is left untouched, so it
 * is safe to run on every reboot.
 *
 * @typedef {{ name: string, vatID?: string }} CriticalPromotionSpec
 *   `name` is the vat label used for discovery + assertion; `vatID` optionally
 *   pins the exact vat (belt-and-suspenders on chains whose id is known at
 *   upgrade-authoring time).
 */

/**
 * Default per-chain promotion table for the ymax portfolio contract, per the
 * kriskowal/garden#29 discussion. ymax1 is critical on agoric-3 mainnet (vat
 * v288); agoricdev-25 has no ymax1, so ymax0 (vat v320) is the target there.
 *
 * @type {Record<string, CriticalPromotionSpec[]>}
 */
export const DEFAULT_CRITICAL_VAT_PROMOTIONS = harden({
  'agoric-3': [{ name: 'ymax1', vatID: 'v288' }],
  'agoricdev-25': [{ name: 'ymax0', vatID: 'v320' }],
});

/**
 * The union of all target labels across the default table — used by label mode
 * when no chainID is available at the call site.
 *
 * @type {CriticalPromotionSpec[]}
 */
export const DEFAULT_CRITICAL_VAT_LABELS = harden(
  Object.values(DEFAULT_CRITICAL_VAT_PROMOTIONS)
    .flat()
    .map(({ name }) => ({ name })),
);

/**
 * @param {SwingStoreKernelStorage} kernelStorage
 * @param {object} [opts]
 * @param {string} [opts.chainID] cosmos chain id; when set, targets are read
 *   from `promotionsByChain[chainID]`.
 * @param {CriticalPromotionSpec[]} [opts.targets] explicit target list; when
 *   set, `chainID` is ignored (label mode).
 * @param {Record<string, CriticalPromotionSpec[]>} [opts.promotionsByChain]
 * @returns {{
 *   chainID: string | undefined,
 *   promoted: { vatID: string, name: string | undefined, wasCritical: boolean }[],
 *   notFound: CriticalPromotionSpec[],
 * }}
 */
export const promoteVatsToCritical = (
  kernelStorage,
  {
    chainID = undefined,
    targets = undefined,
    promotionsByChain = DEFAULT_CRITICAL_VAT_PROMOTIONS,
  } = {},
) => {
  const { kvStore } = kernelStorage;
  /** @param {string} key */
  const getRequired = key => {
    kvStore.has(key) || Fail`storage lacks required key ${q(key)}`;
    // @ts-expect-error already checked .has()
    return kvStore.get(key);
  };

  const specs = targets || (chainID && promotionsByChain[chainID]) || [];
  if (specs.length === 0) {
    return harden({ chainID, promoted: [], notFound: [] });
  }

  // Enumerate every live vat (static + dynamic) and index by label. A vat's
  // label lives in its persisted options blob (`${vatID}.options`), which is
  // also where `critical` lives — see the kvStore schema comment in
  // kernelKeeper.js (`vat.names`, `vat.dynamicIDs`).
  const allVatIDs = [];
  for (const name of JSON.parse(kvStore.get('vat.names') || '[]')) {
    allVatIDs.push(getRequired(`vat.name.${name}`));
  }
  for (const vatID of JSON.parse(kvStore.get('vat.dynamicIDs') || '[]')) {
    allVatIDs.push(vatID);
  }
  /** @type {Map<string, string>} label -> vatID */
  const idByLabel = new Map();
  for (const vatID of allVatIDs) {
    const optionsKey = `${vatID}.options`;
    if (!kvStore.has(optionsKey)) continue;
    const { name } = JSON.parse(getRequired(optionsKey));
    if (typeof name === 'string') idByLabel.set(name, vatID);
  }

  /** @param {CriticalPromotionSpec} spec */
  const resolveVatID = spec => {
    // Prefer the pinned vatID when it is present and live.
    if (spec.vatID && kvStore.has(`${spec.vatID}.options`)) {
      return spec.vatID;
    }
    // Otherwise discover by label: exact match first, then suffix (matching the
    // a3p `getDetailsMatchingVats` convention of `vatName.endsWith(name)`).
    if (idByLabel.has(spec.name)) return idByLabel.get(spec.name);
    for (const [label, vatID] of idByLabel) {
      if (label.endsWith(spec.name)) return vatID;
    }
    return undefined;
  };

  const promoted = [];
  const notFound = [];
  for (const spec of specs) {
    const vatID = resolveVatID(spec);
    if (!vatID) {
      notFound.push(spec);
      continue;
    }
    const optionsKey = `${vatID}.options`;
    const options = JSON.parse(getRequired(optionsKey));
    // Safety assertion: if a spec pins BOTH an id and a name, the resolved
    // vat's label must match, so a stale/moved id is caught rather than
    // silently promoting the wrong vat.
    if (spec.vatID && spec.name && typeof options.name === 'string') {
      (options.name === spec.name || options.name.endsWith(spec.name)) ||
        Fail`promoteVatsToCritical: ${q(spec.vatID)} is labelled ${q(
          options.name,
        )}, expected ${q(spec.name)}`;
    }
    const wasCritical = options.critical === true;
    if (!wasCritical) {
      options.critical = true;
      kvStore.set(optionsKey, JSON.stringify(options));
    }
    promoted.push({ vatID, name: options.name, wasCritical });
  }

  return harden({ chainID, promoted, notFound });
};
harden(promoteVatsToCritical);
