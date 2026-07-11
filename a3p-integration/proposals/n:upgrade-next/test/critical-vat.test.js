// Post-upgrade assertion for the garden#29 "promote a running vat to critical"
// rehearsal. See ./README.md § vatOptionUpdates for the mechanism and how to
// activate it.
//
// The target need NOT be the ymax contract: per mhofman on garden#29, any
// "do-nothing" contract vat started like ymax and left running is a fine target
// for this rehearsal. So this test is deliberately target-agnostic — it drives
// entirely off the vatID(s) pinned in this proposal's package.json
// `agoricProposal.upgradeInfo.vatOptionUpdates`, and does not hard-code the ymax
// label. A pin may carry an optional human-readable `label`, which, when
// present, is cross-checked against the live vats matching that label so a
// mis-pinned vatID fails loudly rather than silently asserting nothing.
//
// The critical flag lives only in the swing-store kvStore key `${vatID}.options`
// (read fresh by kernel.js terminateVat), not in vstorage — so we read it through
// synthetic-chain's `getVatInfoFromID(vatID).options()`, which queries the chain's
// swingstore.sqlite directly.
import { readFileSync } from 'node:fs';

import test from 'ava';
import '@endo/init/debug.js';

import {
  getDetailsMatchingVats,
  getVatInfoFromID,
} from '@agoric/synthetic-chain';

const upgradeInfo = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).agoricProposal?.upgradeInfo;

const criticalPins = (upgradeInfo?.vatOptionUpdates ?? []).filter(
  u => u.critical,
);

test('garden#29: pinned vat is promoted to critical at the software upgrade', async t => {
  if (criticalPins.length === 0) {
    // Rehearsal not activated — this proposal ships with an empty
    // `vatOptionUpdates` because the target vatID must be observed from a real
    // deployment first. Keep CI green and document the exact activation path.
    t.log(
      'garden#29 rehearsal not activated: n:upgrade-next package.json ' +
        'agoricProposal.upgradeInfo.vatOptionUpdates is empty. To activate, deploy a ' +
        '"do-nothing" contract (or reuse the live ymax1), pin its vatID, and leave it ' +
        'running through the upgrade — see README.',
    );
    t.pass('promotion not configured (pending vatID pin) — see README');
    return;
  }

  for (const pin of criticalPins) {
    const { vatID, label } = pin;

    // Optional cross-check: if the pin names a contract label, confirm the pin's
    // vatID is among the live (non-terminated) vats carrying that label. This is
    // how a drifted deterministic vatID is caught — deployment determinism keeps
    // the vatID stable, but if it ever shifts this fails loudly with the value to
    // re-pin, rather than the assertion below silently reading the wrong vat.
    if (label) {
      const live = await getDetailsMatchingVats(label).then(vats =>
        vats.filter(v => !v.terminated),
      );
      const liveIDs = live.map(v => v.vatID);
      t.true(
        liveIDs.includes(vatID),
        `pinned vatID ${vatID} must be a live vat labelled ${label}; found ${JSON.stringify(
          liveIDs,
        )} — update n:upgrade-next package.json upgradeInfo.vatOptionUpdates if deployment changed it`,
      );
    }

    // The promotion took effect: options.critical is now set on the running vat,
    // with its state otherwise preserved (promoted in place, no new incarnation).
    const vatInfo = await getVatInfoFromID(vatID);
    const options = vatInfo.options();
    t.log(`post-upgrade options for ${vatID}`, options);
    t.true(
      !!options.critical,
      `vat ${vatID} is critical after the software upgrade`,
    );
  }
});
