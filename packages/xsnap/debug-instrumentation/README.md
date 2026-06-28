# xsnap debug instrumentation — XS vs V8 stack-depth probes

**Scratch / diagnostic only. Not a feature, not tested, not on any CI path.**

These are the preserved diagnostic artifacts from the garden investigation
`investigate-beta3-ymax0-xs-repro-and-fix`, captured here so they survive GC on
the build host. Pushed to the **bot fork** (`kriscendobot/agoric-sdk`) for
preservation only — no upstream interaction, no PR.

## What this measures and why

`ymax-v0.3.2606-beta3` v320 `startVat` aborts during durable-kind rehydration
with an XS stack overflow. The overflow is **uncatchable** in XS: it does not
throw a JS error, it kills the whole worker (`"exited: stack overflow"`), which
is why the production slog has no error entry — the vat simply dies
mid-rehydration.

All three rehydration entry paths bottom out in the same recursive cycle in
`@endo/pass-style`:

```
passStyleOfRecur  (passStyleOf.js:138)
  → passStyleOfInternal (passStyleOf.js:193)
    → assertRestValid   (copyRecord.js:67)
      → (recurse)                         ~3 non-tail frames per nesting level
```

`marshal` unserialize and patterns `mustMatch`/`checkMatches` both reach the
overflow through this `passStyleOf` descent.

### Measured limits (host `endolinbot`)

| path                      | XS (xsnap v0.14.2) | V8 (this host) | frames/level |
| ------------------------- | ------------------ | -------------- | ------------ |
| native non-tail budget    | ≈ 350 frames       | ~15–30× deeper | 1            |
| `passStyleOf`             | ≈ 115–127 levels   | 2047           | ~3           |
| `marshal` round-trip      | ≈ 110 levels       | 1790           | ~3           |
| `mustMatch`/`checkMatches`| **≈ 15 levels**    | 511            | ~23          |

`mustMatch`/`checkMatches` at ~15 levels is the **binding limit**. XS does proper
tail-call elimination, so only genuine non-tail frames count.

### Attribution (from the investigation)

The Endo/ses bump beta2→beta3 was **ruled out** by bisection: frames-per-level
are identical across the two Endo sets (see `endo-bisection/`). The overflow is
an XS native-stack-depth property (XS ~350 frames vs V8's thousands), triggered
by accumulated durable contract state, not an Endo regression. The actionable fix
is contract-side depth-bounding below ~15 levels, not raising the XS stack.

## Files

- `probe-v8.mjs` — V8 depth probe for `passStyleOf` / `marshal` / `mustMatch`.
  `node probe-v8.mjs` from a workspace with `@endo/*` installed.
- `probe-raw.mjs` — Endo-free baseline: raw non-tail recursion + nested-record
  walk, to convert the above into frames-per-level.
- `scratch-xs-depth.mjs` — **core instrumentation.** Same probe evaluated inside
  a real `xsnap` worker, fresh worker per trial (overflow aborts the worker), to
  get the XS budget. Run from the built `packages/xsnap` workspace.
- `endo-bisection/` — the beta2-vs-beta3 Endo bisection set (verbatim survivors):
  - `probe.mjs` — the V8 bisection probe (explicit beta2 `@endo/*` deps via
    `package.json`).
  - `probe-entry.js` — the in-XS module (`passStyle`/`marshalRT`/`matchD`
    exports) bundled and evaluated inside xsnap; mirrors `probe.mjs`.
  - `init-entry.js`, `es-shim-entry.js` — lockdown + eventual-send shim entries
    bundled into the worker.
  - `package.json` — pins the **beta2** Endo set (`ses@1.15.0`,
    `@endo/pass-style@1.6.3`, `@endo/patterns@1.7.0`, `@endo/marshal@1.8.0`); swap
    to the beta3 set (`ses@2.2.0`, `pass-style@1.8.1`, `patterns@1.9.1`,
    `marshal@1.10.0`) to reproduce the bisection — the results are identical.

## Build workaround (this host class)

Reproducing the XS engine on this host needs a workaround: **yarn's build-script
subprocess gets EACCES on bin-shims even with the sandbox disabled** (the
`node_modules/.bin/*` shims are not executable from yarn's build runner). Bypass
yarn's build runner and run the native builds directly:

1. `corepack yarn@4.12.0 install` (dependency resolution is fine; it's the
   *build scripts* that fail).
2. **`better-sqlite3`** (needed so the swing-store / daemon tests can spawn):
   run the prebuilt-binary fetcher directly instead of letting yarn invoke it:
   ```sh
   cd node_modules/better-sqlite3 && ../.bin/prebuild-install   # fetches better_sqlite3.node
   ```
   If `.bin/prebuild-install` itself is not executable on this host, invoke the
   real entry under the store via node directly, e.g.
   `node node_modules/.store/.../prebuild-install/bin.js`.
3. **`packages/xsnap`**: use the **prebuilt `xsnap-worker`** rather than building
   from source. The investigation used the worker at
   `packages/xsnap/xsnap-native/xsnap/build/bin/lin/release/xsnap-worker`
   (XS v0.14.2).
4. **`@agoric/xsnap-lockdown`**: `node scripts/build-bundle.js` (plain node, no
   yarn build runner).

The general rule for this host class: **invoke the real build entry under node
directly** (`node <store-path>`) instead of relying on the `.bin` shim, which the
sandbox / permission model blocks.

## Provenance

`endo-bisection/*` are the verbatim survivors from `/tmp/endo-beta2/`. The three
top-level probes are faithful reconstructions from the investigation report's
"Deliverable findings" / "Artifacts" sections (the original scratch tree at
`/home/kris/agoric-sdk/{scratch-xs-repro,packages/xsnap}/...` was GC'd before this
capture). Commit identity is the bot (`endolinbot`); no upstream push.
