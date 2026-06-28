# Debugging XS stack overflow in the xsnap worker

This note records the build-and-run methodology used to investigate an XS stack
overflow during a real `importBundle` (the ymax0 v320 investigation, garden
issue #9), so it never has to be reconstructed from a chat thread again. It is a
companion to the engine-side instrumentation, which lives on the bot fork of the
XS engine:

- **Instrumentation patch:** `kriscendobot/xsnap-pub`, branch
  `debug/xs-stack-overflow-trace`, commit `55449665e9076874630f81b90be03f89497b11a0`.
  It edits the `XS_STACK_OVERFLOW_EXIT` arm of `fxAbort()` in
  `xsnap/sources/xsnapPlatform.c` (plus `#include <execinfo.h>`) to dump, on
  inherited stderr: the value-stack fill level, the XS frame chain innermost
  first (each frame's value-stack slot span and source line), and an
  allocation-free native C backtrace.

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
