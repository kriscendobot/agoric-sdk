# Debugging XS stack overflow in the xsnap worker

This note records the build-and-run methodology used to investigate an XS stack
overflow during a real `importBundle` (the ymax0 v320 investigation, garden
issue #9), so it never has to be reconstructed from a chat thread again. It is a
companion to the engine-side instrumentation, which lives on the bot fork of the
XS engine:

- **Instrumentation patch:** `kriscendobot/xsnap-pub`, branch
  `debug/xs-stack-overflow-trace` (HEAD `a8fb4ce`; first landed at
  `55449665e9076874630f81b90be03f89497b11a0`).
  It edits the `XS_STACK_OVERFLOW_EXIT` arm of `fxAbort()` in
  `xsnap/sources/xsnapPlatform.c` (plus `#include <execinfo.h>`) to dump, on
  inherited stderr: the value-stack fill level, the XS frame chain innermost
  first (each frame's value-stack slot span, **JS function name**, source path,
  and line), a value-stack kind histogram + per-wide-frame slot breakdown, and an
  allocation-free native C backtrace. See **§4** for the named/interleaved walk.

The `packages/xsnap-native` submodule pointer is **not** advanced here — at the
time of writing this fork's `master` does not carry an in-tree `xsnap-native`
gitlink, so pinning it would mean fabricating submodule structure. Instead, check
out the xsnap-pub branch above into `packages/xsnap-native` (or your own
checkout) before building.

## 1. Build just the instrumented worker

From `packages/xsnap-native/xsnap/makefiles/lin` (Linux; gcc 13), with the
instrumented xsnap-pub checked out under `packages/xsnap-native`:

```sh
# Remove the symlink to the cached prebuilt FIRST, so the build writes a fresh
# real binary instead of clobbering the shared prebuilt cache.
rm -f ../../build/bin/lin/release/xsnap-worker

make MODDABLE=<pkg>/moddable \
     GOAL=release \
     XSNAP_VERSION=0.15.0 \
     'CC=cc "-D__has_builtin(x)=1"' \
     EXTRA_DEPS=<pkg>/build.config.env \
     -f xsnap-worker.mk
```

Notes:

- `<pkg>` is the absolute path to the xsnap-native package root (the directory
  that contains `moddable/` and `build.config.env`).
- `-rdynamic` is already present in `LINK_OPTIONS`, so `backtrace_symbols_fd`
  resolves symbol names without extra flags.
- The `'CC=cc "-D__has_builtin(x)=1"'` shim works around gcc 13 not defining the
  `__has_builtin` feature macro that the Moddable sources probe.

## 2. Run against a bundle through the fd-3/4 netstring driver

Run the existing fd-3 (commands in) / fd-4 (results out) netstring driver with
the freshly built worker and an `importBundle(<bundle>)` payload:

```sh
XSNAP_WORKER=<absolute path to the fresh build/bin/lin/release/xsnap-worker> \
  node <driver that speaks the fd-3/4 netstring protocol>
```

The trace lands on the worker's inherited **stderr** (not the fd-4 results
channel), because the worker compiles out `fxReport`/console via `mxNoConsole`;
the instrumentation deliberately uses direct `fprintf(stderr, …)` for that
reason.

### Controls (to validate the frame walker)

- **Trivial bundle** → OK, no overflow.
- **Deep-recursion probe** `function f(n){return n>0?1+f(n-1):0;} f(100000)` →
  overflows at **~394 frames** with the value stack at **4093/4096 slots**. This
  validates the frame walker and matches the prebuilt 0.14.2 budget.

## 3. Key calibration result (the conclusion to preserve)

The real ymax0 `importBundle` overflows at only **9 frames, value stack
4096/4096**, with one anonymous activation holding **~2,588 slots** and its
callee **~1,238** — i.e. **wide value-stack exhaustion, not deep recursion.**

The XS value stack is fixed at `stackCount = 4096` in `xsnap-worker.c` with **no
CLI override**, so the budget cannot be raised at runtime; the fix has to reduce
per-activation value-stack pressure in the offending code, not deepen the stack.

## 4. Evolution: named JS frames interleaved with the C stack

The first cut of the frame walk only had the environment ID (the source path)
to label each frame, so the widest activation printed as `(anonymous):0`. The
walk now names every frame the way the engine names frames for `Error.stack`, by
calling the engine's own `fxBufferFrameName(the, buffer, size, frame, "")`
(declared in `xsAll.h`, defined in `xsAll.c`). It is allocation-free for this
purpose (own-property reads only), so it stays safe at exhaustion.

Each row is `depth  slots  kind  jsname @ source:line`:

- **kind** `J` = a JS bytecode function (its code slot is `XS_CODE_KIND` /
  `XS_CODE_X_KIND`; it runs inside one `fxRunID` activation); `C` = a host/native
  builtin. For a `C` frame `fxBufferFrameName` resolves the callback through
  `dladdr`, so **jsname is the native C symbol** — the `C` rows are the literal
  points where the JS stack crosses into native code.
- **jsname** the qualified name (`home.method`, `Ctor.prototype.method`,
  `(anonymous-N)`), so it corroborates directly against the sources.
- **source** the defining module path and current line.

Because XS is a bytecode interpreter, the native C backtrace is shallow and does
**not** carry one C frame per JS frame — all JS frames execute inside one
`fxRunID`. The two stacks are read together by matching a `kind=C` JS row (a host
builtin, named by its C symbol) to the same symbol in the C backtrace.

### Named result (real ymax0 import, on-host worker 0.14.2)

```
value stack: 4096 of 4096 slots used (0 free)
depth slots kind jsname @ source:line
#0  1238 J  (anonymous-6357) @ .../portfolio-deploy/dist/portfolio.contract.bundle.js:21
#1  2588 C  Array.prototype.flatMap @ (no-source):0
#2    15 J  (anonymous-2605) @ .../portfolio.contract.bundle.js:21
#3    21 J  (anonymous-2604) @ .../portfolio.contract.bundle.js:22
#4    18 J  execute @ #0:13146
#5    13 J  compartmentImportNow @ #0:13468
#6    10 J  Compartment.prototype.(anonymous-1600) @ #0:13523
#7    10 C  @fxOnResolvedPromise @ (no-source):0
#8   161 C  (host)
frame#0 span=1238: ... REFERENCE=1232 ... <- (anonymous-6357) @ portfolio.contract.bundle.js:21
frame#1 span=2588: CLOSURE=1986 REFERENCE=521 ... <- Array.prototype.flatMap @ (no-source):0
```

The 2,588-slot activation that was previously `(anonymous)` is now named:
**`Array.prototype.flatMap`** (a host/`C` builtin), invoked from the SES
`compartmentImportNow` -> `execute` module-evaluation path (frames #4–#6, in the
SES/lockdown shim `#0`). The native C backtrace corroborates it: the unnamed
flatMap builtin sits between two `fxRunID` frames, and `fxOnResolvedPromise`
(frame #7's `kind=C` name) appears in both stacks.

The wide frame's slots are **closure-dominated** (~1,986 closures), so the
flatMap is materializing the bundle's module-linking accessor closures as
operands all at once (rather than them being separately rooted bindings); its
callee `(anonymous-6357)` holds a further ~1,232 references. This both
corroborates and sharpens the earlier "~2,000 persistent closure slots / flat
module scope" read: the *mechanism* that makes them co-resident on the value
stack is a single `flatMap` call during compartment import, not independent
top-level bindings.

### Honest limit / next lever

The contract bundle is minified onto a couple of lines, so `:21`/`:22` cannot be
mapped to an exact source construct by the path+line alone; a sourcemapped
re-bundle (or stubbing the bundler's link helper) is the remaining lever to name
the precise `flatMap` call site. The contract's *own* module-body `flatMap`s
(`portfolio.contract.ts`, `pos-evm.flows.ts`, `type-guards*.ts`) are all over
single-/double-digit arrays — two orders of magnitude too small — so the wide
flatMap is in the bundle's module-linking layer, not contract source.

### Controls

- **Trivial bundle** → OK, no overflow (the named walk does not fire, confirming
  no spurious crash from the richer instrumentation).
- Feeding the **beta3-built** ymax0 bundle under the **beta2** Endo runtime still
  overflows: the controlling variable is the **bundle's** flattened module width
  fixed at bundle time, not the runtime Endo set. The clean control is a contract
  **re-bundled** against beta2 (narrower module scope), per §earlier rounds.
