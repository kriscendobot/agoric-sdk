# Adding ERC-4626 vaults through the ymax `creatorFacet`

Status: design proposal, not implemented.

Origin: <https://github.com/kriskowal/garden/issues/67>. The question asked was:
adding two Morpho v2 vaults looked like it was mostly (perhaps entirely)
configuration data, so what would it take to have a `creatorFacet` method that
adds a new ERC-4626 vault? Identify the implementation risks. Is the static
`InstrumentId` enumeration in `@agoric/portfolio-api` an obstacle, and what does
moving past it cost? Cover every component of
[DESIGN-BETA.md](./DESIGN-BETA.md): contract, YDS, EMS, planner, resolver, UI.

Baseline for every file reference below: `70d307de7f`
(`ymax-v0.3.2607-beta5`).

## 1. What adding a vault costs today

Two recent, representative changes:

| Change | Files | Lines |
| --- | --- | --- |
| PR 12767, three Morpho v2 vaults (merge `999dc4420f`) | 6 | +45 |
| PR 12822, Huma USDC Main (merge `70d307de7f`) | 6 | +16 |

The six files are the same both times:

1. `packages/portfolio-api/src/instruments.js`: a new key in the frozen
   `InstrumentId` record.
2. `packages/portfolio-api/src/places.ts`: a new entry in `ERC4626PoolPlaces`
   giving `protocol` and `chainName`.
3. `packages/portfolio-deploy/src/axelar-configs.js`: the vault address, twice
   (once in `erc4626VaultAddresses`, once wired into `mainnetContracts[chain]`).
4. `packages/portfolio-contract/test/network/prod-network.test.ts`: the id
   appended to `POOLS`, which a test compares for exact equality against
   `Object.keys(PoolPlaces)`.
5. `packages/portfolio-deploy/test/privateArgs-ymax0.json`, and
6. `packages/portfolio-deploy/test/privateArgs-ymax1.json`: golden fixtures.

The diff really is only configuration data. What is expensive is everything
downstream of the diff, and none of it appears in the diff:

- `@agoric/portfolio-api` has to be republished, because the planner, YDS, and
  the UI all learn the instrument set by importing that package at build time.
- The `ymax-planner` service has to be rebuilt and redeployed, because it
  derives vault addresses by statically importing `axelarConfig` from
  `@aglocal/portfolio-deploy` (`services/ymax-planner/src/main.ts:37-39`,
  `services/ymax-planner/src/evm-utils.ts:33-81`).
- **Both** ymax0 and ymax1 have to be upgraded with new `privateArgs`, as both
  PR descriptions state. The vault address reaches the contract only through
  `privateArgs.contracts`, which is read once per incarnation
  (`packages/portfolio-contract/src/portfolio.contract.ts:404-420`).
- That upgrade replays the async-flow logs. `ymax-upgrade.ts:54` allows ten
  minutes for the replay, which is the honest measure of the operational risk
  being taken to add a row to a table.

So the cost is not the configuration change. The cost is that a configuration
change is currently only expressible as a code release plus two contract
upgrades.

## 2. Inventory: what is actually keyed on the static enumeration

This is the part that decides the size of the job. The good news is that the
codebase has already been half-prepared for extensibility, deliberately and with
a naming convention (`Ext` for "extensible").

### 2.1 Already dynamic, needs no change

| Site | Why it is already fine |
| --- | --- |
| `portfolio-contract/src/type-guards.ts:127-131` | `PoolKeyExt = string`, `PoolKeyShapeExt = M.string()`, commented "includes PoolKeys in future upgrades". |
| `portfolio-contract/src/portfolio.exo.ts:519` | The positions `MapStore` uses `keyShape: PoolKeyShapeExt`. Durable store key shapes are persisted and cannot be tightened later, so this being permissive today is what makes the whole design possible. |
| `type-guards.ts:138,216-238` | `TargetAllocationShapeExt` and `PortfolioStatusShapeExt` already accept arbitrary pool keys in published vstorage values. |
| `portfolio-api/src/type-guards.ts:53-64` | `isERC4626InstrumentId` and `isBeefyInstrumentId` are prefix tests, not membership tests. |
| `portfolio-api/src/places.ts:196-210` | `chainOf` already falls back to parsing `${Protocol}_${Chain}` for ids absent from `PoolPlaces`, "to enable base graph edges for pools even if not listed". |
| `portfolio-api/src/evm-wallet/eip712-messages.ts:136-138` | The EIP-712 `Allocation.instrument` field is typed `string`. The EMS wire format is already open. |
| `portfolio-contract/src/resolver/*` | The resolver keys on remote wallet address, `txId`, and transaction type. It never sees a pool key. |

### 2.2 Hard-enumerated, must change

| Site | What it does | Consequence |
| --- | --- | --- |
| `type-guards-steps.ts:27-34` | `AssetPlaceRefShape` is `M.or(..., ...keys(PoolPlaces))`. | This is the real gate. Every `MovementDesc` in every offer and every planner-submitted plan is matched against it. A step naming an unregistered pool is rejected here. |
| `type-guards.ts:133-136` | `TargetAllocationShape` enumerates `keys(PoolPlaces)`. | Used in `openPortfolio`/`rebalance` offer args (`type-guards-steps.ts:164,172`) and in `PortfolioDelegatedSetTargetAllocationParamsShape` (`delegation.exo.ts:38-46`). |
| `portfolio.flows.ts:625` | `getAssetPlaceRefKind` classifies a ref as a position by `keys(PoolPlaces).includes(ref)`. | Module-scope; not parameterized by contract state. |
| `portfolio.flows.ts:683,785` | `PoolPlaces[poolKey]` supplies `protocol` and `chainName` to `wayFromSrcToDest`. | Same. `wayFromSrcToDest` is exported and unit-tested as a pure function. |
| `portfolio.contract.ts:247-277` | `ERC4626Contracts = { [K in keyof typeof ERC4626PoolPlaces]: '0x…' }`, mixed into `EVMContractAddresses`. | The type that ties `privateArgs.contracts` keys to instrument ids. |
| `pos-evm.flows.ts:497-524` | `ERC4626Protocol.supply/withdraw` resolve the vault by `a[poolKey]` where `a = contracts[chain]`. | The only place the address is consumed. Small and easy to redirect. |
| `tools/network/buildGraph.ts:157-175` | Pool graph nodes derive from `typedEntries(PoolPlaces)`. | The planner's route graph. Note it already synthesizes nodes for every `PoolPlaces` entry whose hub is present, so `PROD_NETWORK.pools` is only carrying extra metadata such as `blockDepositReason`. |
| `services/ymax-planner/src/evm-utils.ts:57` | Vault addresses picked out of the statically imported `axelarConfig`. | Planner redeploy required today. |
| `services/ymax-planner/src/yds-portfolio-balances.ts:96-98` | `Object.hasOwn(PoolPlaces, instrumentId) \|\| Fail\`Invalid YDS instrument id\`` | The planner **throws** on a YDS instrument it does not know. See risk R6. |
| `services/ymax-planner/src/plan-deposit.ts:145` | `getOwn(PoolPlaces, instrument)`. | |

Counting runtime (not type-level) uses of `PoolPlaces`: eleven sites across the
contract, the planner, the graph builder, and one test.

### 2.3 One thing the enumeration is silently doing

`portfolio.exo.ts:1491-1503` builds a `TargetAllocation` straight from the
EIP-712 allocations arriving over the EMS, with the comment
`// XXX: validate instruments`. Nothing validates them there. The only thing
that stops an arbitrary string reaching a position today is that the planner's
plan, when it eventually names that destination, fails `AssetPlaceRefShape`.

That matters for this design: **relaxing `AssetPlaceRefShape` removes an
accidental backstop**, so the registry lookup has to become an explicit check
rather than an implicit one. Done right this is a net improvement, because the
explicit check also covers the EMS path that has no check at all today.

## 3. Proposed design

### 3.1 A durable instrument registry in the contract

Add, in the contract's durable zone:

```js
// portfolio.contract.ts
const instrumentRegistry = zone.mapStore('instruments', {
  keyShape: M.string(),                 // PoolKeyShapeExt
  valueShape: M.splitRecord(
    {
      protocol: M.string(),             // 'ERC4626'
      chainName: M.string(),            // AxelarChain name
      address: M.string(),              // EIP-55 checksummed 0x…
      status: M.string(),               // see below
    },
    { asset: M.string(), depositCap: M.nat(), note: M.string() },
    M.record(),                         // tolerate fields added later
  ),
});
```

Two shape notes that are load-bearing:

- The `valueShape` is persisted with the store and cannot be tightened in a
  later incarnation. Use `M.splitRecord` with an open rest pattern from day one
  so that fields can be added without a store migration.
- `keyShape: M.string()` matches what the positions store already does, so
  positions and registry entries stay key-compatible.

`status` is a small state machine, and it is the answer to "you can add but you
can never remove":

- `probationary`: known, withdrawals allowed, deposits refused. This is the
  state a vault is created in.
- `active`: fully tradable.
- `depositsBlocked`: liquidity or capacity concern; withdrawals still allowed.
- `retired`: no new deposits, no new positions; existing positions can be
  unwound. Never deleted, because positions and vstorage history reference the
  key forever.

### 3.2 The `creatorFacet` methods

```js
addERC4626Vault({
  instrumentId,   // 'ERC4626_morphoFooUsdc_Base'
  chainName,      // 'Base'
  address,        // '0x…', EIP-55 checksummed
  asset,          // optional; defaults to that chain's USDC from privateArgs
  depositCap,     // optional NatValue
})
setInstrumentStatus(instrumentId, status)
```

Validation performed synchronously by `addERC4626Vault`:

1. `instrumentId` matches `/^ERC4626_[A-Za-z0-9]+_[A-Za-z0-9]+$/` and its chain
   suffix equals `chainName`. This keeps `chainOf`'s existing syntactic fallback
   correct for free.
2. `chainName` is a key of `AxelarChain` and the contract has a configuration
   for it in `privateArgs.contracts`.
3. `address` is a well-formed, EIP-55 checksummed hex address. Requiring the
   checksum (not merely the hex) is a cheap typo detector.
4. The id is not already registered with a **different** address. Re-adding with
   the same address is a no-op; re-pointing an existing id is refused outright.
   See risk R1: the registry is append-only in the values that matter.
5. The address is not already registered under a different id on the same chain.

There is deliberately no `removeInstrument`. Retirement is a status change.

`addERC4626Vault` publishes the new entry to vstorage and returns nothing. The
whole call is synchronous and local: no orchestration, no GMP, no vow.

### 3.3 Address resolution: overlay, not migration

`ERC4626Protocol.supply/withdraw` and `makeEVMPoolCtx` should resolve through a
single helper:

```js
const lookupVault = (chainName, poolKey) =>
  (instrumentRegistry.has(poolKey) && instrumentRegistry.get(poolKey).address)
  || contracts[chainName][poolKey]
  || Fail`no address for ${q(poolKey)} on ${q(chainName)}`;
```

The registry is an **overlay** on `privateArgs.contracts`. This is the cheapest
correct option:

- No migration. The roughly forty vaults configured today keep working with no
  registry entries at all.
- No drift. `privateArgs.contracts` keeps supplying the non-vault addresses it
  must supply anyway (`usdc`, `permit2`, `gateway`, `gasService`, `walletHelper`,
  the factories), so it is not being retired, only stopped from growing.
- The seeding alternative (copy `privateArgs` vault addresses into the registry
  on first incarnation) can be done later as a cleanup and is not needed for
  correctness.

Similarly, `PoolPlaces` lookups become `providePoolPlace(poolKey)`, which
consults the registry first and falls back to the static `PoolPlaces`. Since a
registry entry carries `protocol` and `chainName`, this returns the same
`PoolPlaceInfo` shape either way and `wayFromSrcToDest` needs a lookup function
threaded in rather than a rewrite.

### 3.4 Shapes: from enumeration to structure plus an explicit check

`AssetPlaceRefShape` and `TargetAllocationShape` are module-scope constants,
evaluated at module load. They cannot see runtime state at all, and an
interface guard is fixed for the life of an incarnation even if it could. So the
shapes must become structural, and the membership test must move into code:

```js
// structural, in the pattern. Endo patterns have no regex combinator, so the
// pattern is only a string test and the format check lives in code.
const AssetPlaceRefShapeExt = M.or(
  ...seatKeywords.map(kw => `<${kw}>`),
  '+agoric',
  ...values(AxelarChain).map(c => `+${c}`),
  ...values(AxelarChain).map(c => `-${c}`),
  ...values(SupportedChain).map(c => `@${c}`),
  PoolKeyShapeExt,                  // M.string(), was ...keys(PoolPlaces)
);

// membership, in code, at each place external input is accepted
const assertKnownPlace = ref => {
  if (!isInstrumentId(ref)) return;            // seat/chain/account refs unaffected
  const info = providePoolPlace(ref);
  info || Fail`unknown instrument ${q(ref)}`;
  info.status === 'active' || info.status === 'depositsBlocked' ||
    Fail`instrument ${q(ref)} is not tradable`;
};
```

Four consequences worth being explicit about:

- Widening one arm of `AssetPlaceRefShape` to `M.string()` widens the whole
  union, so the shape stops rejecting malformed *non-instrument* refs such as
  `@Bogus` as well. Several helpers currently carry the comment "validation of
  external data is done by `AssetPlaceRefShape`; any bad ref that reaches here is
  a bug" (`type-guards-steps.ts:56-96`). Those asserts still fail closed, but
  they move from "unreachable" to "reachable from external input", and their
  comments must be corrected. `getAssetPlaceRefKind` (`portfolio.flows.ts:622`)
  becomes the single classifier that has to be right.
- The check has to run on **all four** entry points: `openPortfolio` and
  `rebalance` offer args (`portfolio.contract.ts:756`), planner
  `resolvePlan`/`rebalance` (`planner.exo.ts:105-166`), the delegated
  `setTargetAllocation` path (`delegation.exo.ts`), and the EMS
  `rebalance(allocations)` path (`portfolio.exo.ts:1491`). The fourth is
  currently unchecked, which is the `XXX: validate instruments` above.
- Deposit-versus-withdraw asymmetry belongs here too: a step whose `dest` is a
  `retired` or `probationary` instrument must fail, while a step whose `src` is
  that instrument must succeed, or retirement traps funds.
- `zone.exoClass` interface guards are re-supplied on every incarnation and are
  not persisted (only `stateShape` is compared across incarnations, see
  `packages/swingset-liveslots/src/virtualObjectManager.js:256-298`), so this
  change is upgrade-safe. But it does mean a guard can never reflect a
  mid-incarnation registry addition, which is precisely why the guard must be
  structural rather than enumerated.

### 3.5 Publication: vstorage is the distribution channel

The contract already publishes a contract-level status node (`published.ymax0`,
`StatusFor['contract']`, written at `portfolio.contract.ts:483-490`). Extend it
following the existing `portfolios`/`portfolio<N>` pattern rather than inflating
one value:

```
published.ymax0.instruments               -> { instrumentIds: [...] }
published.ymax0.instruments.<instrumentId> -> { protocol, chainName, address,
                                                status, asset?, depositCap? }
```

Per-instrument child nodes keep each write small, give the planner and the UI a
natural change feed, and avoid a single value that grows without bound. Add the
paths to `PortfolioPublishedPathTypes` in `portfolio-api/src/types.ts:428-437`.

This node is what makes the whole thing work off-chain: it is the first time the
authoritative instrument set is readable at runtime instead of compiled in.

### 3.6 Component by component

**Contract.** Sections 3.1 to 3.5. This is where essentially all the work is.

**Planner** (`services/ymax-planner/`). Three changes:

1. Replace `getPoolTokenAddresses(axelarConfig)` (`evm-utils.ts:33`) with a map
   built from `published.ymax0.instruments.*`, merged over the static config as
   a fallback, and refreshed when the vstorage node changes. The planner already
   has a vstorage watcher and a `PROD_NETWORK` load path at `main.ts:517`.
2. `buildGraph`'s `possiblePoolKeys` (`buildGraph.ts:167-171`) takes the pool
   set as an argument instead of reading `PoolPlaces` directly, so the graph
   grows without a redeploy. `PROD_NETWORK.pools` stays as the place for
   hand-tuned per-pool metadata; entries for unknown pools become inert rather
   than fatal.
3. `yds-portfolio-balances.ts:96-98` stops throwing on an unrecognized
   instrument id and instead warns and skips. See risk R6.

**YDS** (the ymax data service, `yds/` in `Agoric/ymax-web`). YDS is already the
one component with a **dynamic** instrument list: the planner fetches
`instruments?includeAll=true` and derives deposit/withdraw blocks from `tvl`,
`liquidityUsd`, and `totalSupplyUsd` (`services/ymax-planner/src/main.ts:377-391`,
`instrument-status.ts`). So YDS needs the least conceptual change and the most
care about ordering:

- YDS keeps ownership of market data and of display metadata (name, curator,
  logo, APY history). None of that belongs on chain.
- YDS should treat `published.ymax0.instruments` as the authority for *whether
  an instrument is tradable*, and reconcile: an instrument it tracks but the
  contract does not know is display-only; an instrument the contract knows but
  YDS does not have data for should still render, with unknown market data.
- YDS should not be able to introduce an instrument id that the contract has
  never heard of into the planner's input, which is the coupling that risk R6
  describes.

**EMS** (the EVM message service, per [evm-wallet.md](./evm-wallet.md)). The
wire format needs no change: `Allocation.instrument` is already `string`. Two
optional improvements:

- The EMS does early structural validation to keep junk off chain
  (evm-wallet.md, "verify structure, deadline"). Reading the same vstorage
  registry lets it reject an allocation naming an unknown instrument before
  spending gas. This is a spam filter, not the security boundary; the contract
  check in 3.4 is the boundary.
- Nothing about `verifyingContract`, nonce, or deadline handling is affected by
  a new vault, because the EMS validates the ymax handler's own addresses, not
  the vault's.

**Resolver.** No change. Per [resolver-service.md](./resolver-service.md) and
`src/resolver/types.ts`, resolution keys on transaction type
(`MAKE_ACCOUNT`, `CCTP_TO_EVM`, `GMP`, `ROUTED_GMP`, the IBC types), the remote
wallet address, the source LCA address, and the `txId`. A supply into a new
vault is an ordinary `GMP` transaction to the remote wallet. The resolver never
resolves the vault address, so it needs neither a redeploy nor a registry read.
This is the one component the design gets for free, and it is worth saying so
explicitly because it is the component most people assume will need work.

**UI** (ymax.app). Two requirements:

- Render from data, not from a bundled union. The allocation editor's instrument
  list must come from YDS reconciled with `published.ymax0.instruments`, so a
  newly added vault appears without a front-end release. If the UI keeps a
  compiled-in list, the `creatorFacet` method buys nothing for users.
- Degrade gracefully for an instrument with no display metadata yet: derive a
  human label from the id (the middle segment is already camel-cased vault
  naming) rather than showing a blank or dropping the row. A vault can be
  registered on chain minutes before YDS has curated data for it.

### 3.7 Suggested phasing

Each phase is independently shippable and independently valuable.

- **Phase 0.** Turn the enumerated shapes into structural shapes plus explicit
  membership checks against the *existing static* `PoolPlaces`. No behavior
  change, no registry, no new authority. This is the bulk of the correctness
  risk and it can be reviewed and soaked on its own. It also closes the
  `XXX: validate instruments` gap on the EMS path.
- **Phase 1.** Add the durable registry, the overlay lookup, the two
  `creatorFacet` methods, and the vstorage publication. Requires one upgrade to
  install, and it is intended to be the last upgrade required to add a vault.
- **Phase 2.** Planner reads the registry from vstorage; stop deriving vault
  addresses from the statically imported `axelarConfig`.
- **Phase 3.** YDS and the UI read the registry; remove compiled-in instrument
  lists.
- **Phase 4, optional.** Widen the `InstrumentId` type (section 4).

After phase 2, adding a vault is one `creatorFacet` call plus a YDS row. After
phase 3 it is one `creatorFacet` call.

## 4. The `InstrumentId` question

**Short answer: yes, the runtime has to become dynamic, but the static type does
not have to be given up, and it should not be.**

### 4.1 What the static union is buying today

1. Typo detection at roughly forty literal call sites in tests, fixtures, and
   `PROD_NETWORK`.
2. Exhaustiveness: `PoolPlaces` is declared
   `satisfies Record<InstrumentId, PoolPlaceInfo>`, so a new id with no place
   entry fails to compile.
3. `ERC4626Contracts = { [K in keyof typeof ERC4626PoolPlaces]: '0x…' }`, which
   ties `privateArgs.contracts` keys to instrument ids.
4. Editor autocomplete in the planner and the UI.
5. An accidental runtime allowlist, through the enumerated patterns (section
   2.3). This one is not a type-system benefit and is the one that actually
   matters for safety.

### 4.2 The recommended shape: an open union

TypeScript has a well-known idiom for exactly this:

```ts
/** Instruments known at the time this package was published. */
export type KnownInstrumentId = (typeof InstrumentId)[keyof typeof InstrumentId];

/** Any instrument, including ones registered after this package was built. */
export type InstrumentId = KnownInstrumentId | (string & {});

/** Structural constraint for a dynamically registered ERC-4626 instrument. */
export type ERC4626InstrumentIdExt = `ERC4626_${string}_${AxelarChain}`;
```

`KnownInstrumentId | (string & {})` preserves autocomplete for the known set
while accepting any string. That keeps benefit 4 and most of benefit 1 (a typo
in a *known* id still autocompletes correctly), at the cost of no longer
rejecting an unknown literal.

The template-literal type keeps shape checking where shape is what matters,
which pairs with `chainOf`'s existing syntactic fallback and with the
`addERC4626Vault` id validation in 3.2. A malformed id is still a compile error;
an unknown but well-formed id is not.

### 4.3 What the change costs, concretely

| Loss | Replacement | Cost |
| --- | --- | --- |
| `satisfies Record<InstrumentId, PoolPlaceInfo>` exhaustiveness on `PoolPlaces` | `satisfies Record<KnownInstrumentId, PoolPlaceInfo>`; unchanged for the static set | none, keep it |
| `ERC4626Contracts` mapped type over `keyof typeof ERC4626PoolPlaces` | `Partial<Record<ERC4626InstrumentIdExt, '0x…'>>` plus a deploy-time validation script over `axelar-configs.js` | one small script; the mapped type was only checking the static set anyway, and the registry supersedes it |
| `TargetAllocation = Partial<Record<InstrumentId \| '@'AxelarChain, bigint>>` key checking | open union, key checking becomes shape checking | acceptable; runtime check in 3.4 is stronger than what the type gave |
| `StatusFor['portfolio'].positionKeys: InstrumentId[]` | unchanged with the open union | none |
| `YdsInstrument.id: AssetPlaceRef` (`instrument-status.ts:7`) | unchanged with the open union | none |
| Planner `Partial<Record<InstrumentId, EvmAddress>>` (`engine.ts:212`) | unchanged with the open union | none |
| The accidental runtime allowlist (2.3) | explicit registry check in 3.4 | this is work, and it is the single most important part of the whole design |

Rough size, from the counted call sites rather than a guess: the contract-side
change is around ten runtime call sites plus four validation entry points plus
the registry and publication; the planner change is three call sites plus a
vstorage subscription. The type widening itself is nearly free. **The expensive
part is not the type, it is the four validation entry points and the tests
around them.**

### 4.4 The option not taken

Keeping the enumeration and adding the `creatorFacet` method anyway does not
work: a registered vault the contract would happily supply to would still be
rejected by `AssetPlaceRefShape` when the planner names it in a step. The
enumeration and the registry cannot both be authoritative. If the enumeration
must stay authoritative, then the honest answer to the original question is that
a `creatorFacet` method is not achievable and the current release-plus-upgrade
process is the design.

## 5. Implementation risks

**R1. Async-flow replay divergence.** `privateArgs.contracts` is captured into
the orchestration context at incarnation (`portfolio.contract.ts:500-538`) and
flows replay against a durable log. If an in-flight flow re-executes and reads a
*different* address for the same pool key than it read originally, the generated
GMP calldata differs and the replay fails. Mitigation: the registry is
append-only in the address field, enforced at 3.2 step 4. A vault whose address
must change is a new instrument id, never an in-place edit. This constraint is
cheap to honor and expensive to discover later.

**R2. Interface guards are per-incarnation.** A pattern built at module load or
at contract preparation cannot observe a mid-incarnation registry addition.
Any design that tries to "regenerate the shape when a vault is added" is
therefore wrong. The only correct approach is structural shapes plus an explicit
check (3.4). Corollary: relaxing the shape removes today's accidental allowlist,
so the explicit check must land in the *same* change, not a follow-up.

**R3. Durable shapes cannot be tightened.** The positions `MapStore` key shape
is already `M.string()`, which is what makes this possible. The new registry's
`valueShape` gets exactly one chance to be right. Use an open `M.splitRecord`
rest pattern (3.1), and do not put a pattern on `address` tighter than
`M.string()` even though the method validates the checksum, because a future
chain family with a different address format would otherwise require a store
migration.

**R4. Authority is unchanged; review is not.** The `creatorFacet` is held in the
deploying account's store (`invite-ems.ts:44`, `ymax-get-creator-facet.ts`), and
that same holder can already upgrade the contract with arbitrary `privateArgs`.
So the method grants no authority the key does not already have. What it removes
is the code review, CI run, and release process that today sit incidentally
between "someone picked an address" and "the contract will approve USDC to it".
Restoring a deliberate equivalent is a design requirement, not a nicety:
recommend the two-phase activation in R5, and consider requiring a distinct
holder for `setInstrumentStatus(id, 'active')` than for `addERC4626Vault`.

**R5. A wrong or hostile vault address is a fund-loss vector.** `supply` does
`usdc.approve(vaultAddress, amount)` followed by `vault.deposit(...)`
(`pos-evm.flows.ts:497-511`). An address that is not a conforming ERC-4626 vault
can take the approved USDC and return nothing the contract can account for.
Fee-on-transfer behavior, a non-reverting failed deposit, and a vault whose
`asset()` is not that chain's USDC are all plausible accidents, quite apart from
malice. Mitigation, and this is the strongest single recommendation in this
document:

> **Two-phase activation.** `addERC4626Vault` creates the entry as
> `probationary`, which permits withdrawals and refuses deposits. An off-chain
> verifier reads the chain and attests. Only an attested instrument can be moved
> to `active`.

This fits the existing architecture rather than adding to it: the planner
already holds Alchemy RPC access and already reports off-chain observations back
on chain through the resolver's invitation-based seat. Reading `asset()`,
`decimals()`, `maxDeposit()`, and a nonzero `totalAssets()` from a candidate
vault is a few lines in `evm-scanner.ts` next to the existing balance reads. A
`depositCap` per instrument bounds the damage from an attestation that is itself
wrong.

**R6. Planner/YDS/UI version skew, in both directions.** Today
`yds-portfolio-balances.ts:96-98` throws `Invalid YDS instrument id` on any
instrument YDS reports that the planner's compiled `PoolPlaces` lacks. That is a
live coupling: YDS adding an instrument before the planner is redeployed can
break portfolio balance normalization. A dynamic registry makes this *more*
likely, not less, since the contract can now gain an instrument without any
redeploy at all. Mitigation: make every off-chain consumer tolerant of unknown
ids (warn and skip, never throw), and make the vstorage registry the
tie-breaker. This should ship in phase 2, before the first real use of the
method.

**R7. vstorage value growth.** Roughly forty instruments today. One node holding
the whole registry is fine now and is not fine indefinitely. Per-instrument
child nodes plus an index (3.5) also give consumers a change feed instead of a
diff.

**R8. Retirement, not removal.** Positions, published position nodes, and flow
history reference pool keys permanently. A `removeInstrument` would strand
positions and break historical vstorage reads. Only `status` transitions, and
`retired` must still allow withdrawal steps (3.4).

**R9. Tests aimed at the wrong invariant.** `prod-network.test.ts:155-157`
asserts `Object.keys(PoolPlaces)` deep-equals a hand-maintained `POOLS` array.
Once the registry exists, that test is asserting a property of a
partially-authoritative list. Re-aim it: assert that every *statically* declared
place is reachable in the graph, and add a separate test that a
registry-supplied instrument produces a valid graph node and a valid supply and
withdraw step. Similarly, `privateArgs-ymax0.json` and `privateArgs-ymax1.json`
stop growing, and a new fixture covers the registry path.

**R10. Two contracts, one registry each.** ymax0 and ymax1 each hold their own
durable registry and publish to their own vstorage node. `addERC4626Vault` has
to be called on both, and they can diverge. That is not worse than today (both
need the upgrade today), but it becomes easier to forget one, because the
symptom moves from a failed deploy to a vault that quietly exists on one
contract only. Recommend the operator tooling
(`packages/portfolio-deploy/src/ymax-*.ts`) grow a single command that targets
both and reports divergence.

**R11. The id is a permanent public name.** `ERC4626_morphoFooUsdc_Base` appears
in vstorage paths, in EIP-712 signed messages, and in the UI. A typo in an id
cannot be fixed by renaming, only by retiring and re-adding, which orphans any
position opened in the interim. Validate the id format hard (3.2), and consider
having the operator tool derive the id from the vault's on-chain `name()`
instead of accepting free text.

## 6. Summary

- Adding a vault is genuinely configuration-only in the diff, and genuinely a
  code release plus two contract upgrades in practice. The gap is that the
  address reaches the contract only through `privateArgs`.
- The durable state is already extensible on purpose (`PoolKeyShapeExt`,
  `TargetAllocationShapeExt`, the positions store key shape). The blocking
  layer is the enumerated *patterns*, not the durable state, and not really the
  TypeScript type.
- The static `InstrumentId` union can stay as an open union. Widening it is
  nearly free. Replacing the runtime allowlist it accidentally provides is the
  real work.
- The resolver needs no change at all. The EMS wire format needs no change. The
  planner needs a vstorage subscription in place of a static import. YDS and the
  UI need to stop compiling in an instrument list.
- The dominant risk is not upgrade mechanics; it is that a single method call
  now decides which contract the ymax remote wallet will approve USDC to.
  Two-phase activation with an off-chain attestation, plus a per-instrument
  deposit cap, is the mitigation that fits the architecture already present.
