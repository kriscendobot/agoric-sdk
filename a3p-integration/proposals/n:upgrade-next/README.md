# Proposal to upgrade the chain software

The `UNRELEASED_A3P_INTEGRATION` software upgrade may include core proposals
defined in its upgrade handler. See `CoreProposalSteps` in the
`unreleasedUpgradeHandler` in
[golang/cosmos/app/upgrade.go](../../../golang/cosmos/app/upgrade.go).

This test proposal may also include `coreProposals` in its `upgradeInfo`, which
are executed after those defined in that upgrade handler. See `agoricProposal`
in [package.json](./package.json).

The "binaries" property of `upgradeInfo` is now required since Cosmos SDK 0.46,
however it cannot be computed for an unreleased upgrade. To disable the check,
`releaseNotes` is set to `false`.

## `vatOptionUpdates` — promoting a running vat to `critical` (garden#29)

This proposal's `upgradeInfo` may also carry a `vatOptionUpdates` array, the
proposer-supplied channel for the in-place vat-option promotion added in
kriskowal/garden#29 (`applyVatOptionUpdates` in
[packages/SwingSet/src/controller/upgradeSwingset.js](../../../packages/SwingSet/src/controller/upgradeSwingset.js),
wired in
[packages/cosmic-swingset/src/launch-chain.js](../../../packages/cosmic-swingset/src/launch-chain.js)).
Each entry is `{ "vatID": "vNNN", "critical": true }`: it read-modify-writes that
running vat's persisted `${vatID}.options` blob at the upgrade's reboot point, so
`terminateVat()` will `panic()` (halt the chain) instead of severing the vat.

There are two channels, merged and applied together:

- **structured** — `upgradeDetails.vatOptionUpdates`, hard-coded per chain in the
  cosmos upgrade handler (`golang/cosmos/app/upgrade.go`, gated on `ChainID()`:
  `agoric-3`→`v288`/ymax1, `agoricdev-25`→`v320`/ymax0). The synthetic chain's
  chain-id matches neither, so **nothing** is injected here on a3p; and
- **flexible** — this proposal's `upgradeInfo.vatOptionUpdates` (below), which is
  therefore the channel an a3p rehearsal must use.

### Activating the a3p rehearsal

It ships **empty** (a no-op — the chain boots normally and nothing is promoted),
because the target vatID must be observed from a real deployment first.

Two maintainer decisions from garden#29 (mhofman, 2026-07-10) shape the target:

- **The target need not be ymax.** "Any 'do-nothing' contract we deploy and mark
  as critical is fine" — the rehearsal only needs *some* live dynamic contract vat
  to promote, so it does not have to couple to the `g:ymax1` suite.
- **Leaving the target vat running through the upgrade is fine** — that mirrors
  what actually happened on mainnet (a live ymax1 across an upgrade), so the
  earlier "must not leave ymax alive" hesitation is resolved: keeping the target
  vat alive into this upgrade is the intended shape, not a hazard.

`test/critical-vat.test.js` is therefore **target-agnostic**: it drives purely off
the pinned vatID(s) and does not hard-code the ymax label. A pin may carry an
optional `label` for a human-readable cross-check.

To activate the rehearsal, pick a target and pin it:

- **Recommended — a self-contained "do-nothing" contract.** Start a trivial
  contract vat in an earlier step and leave it running, then pin its vatID here.
  This keeps the rehearsal self-contained and does not perturb `g:ymax1`.
- **Alternative — reuse the live ymax1.** Run `g:ymax1`, read the
  `garden#29 ymax1 deterministic vatID` line it logs (see
  `g:ymax1/test/ymax1.test.js`), and pin that. Because deployment is
  deterministic, the vatID is stable across runs. This path additionally requires
  dropping `g:ymax1`'s final terminate step so a live ymax1 survives into the
  upgrade (per the decision above, leaving it running is acceptable) — otherwise
  `applyVatOptionUpdates` fails its live-dynamic-vat guard.

Either way, pin the observed vatID (and, optionally, its label) here:

```json
"vatOptionUpdates": [{ "vatID": "vNNN", "critical": true, "label": "ymax1" }]
```

If the observed vatID ever changes, this pin must be updated to match; when a
`label` is given, `critical-vat.test.js` cross-checks the pin against the live
vats carrying that label and fails loudly on drift.

With a pin in place, `critical-vat.test.js` asserts the vat's `options().critical`
is `true` after the upgrade.

> Note: the concrete vatID must be **observed from a real synthetic-chain run**
> (it is not in vstorage; it is read from the chain's swing-store), so activation
> requires one Docker-capable a3p run to produce the value to pin.