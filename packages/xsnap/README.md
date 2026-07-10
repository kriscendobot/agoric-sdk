# xsnap

Xsnap is a utility for taking resumable snapshots of a running JavaScript
worker, using Moddable’s XS JavaScript engine.

Xsnap provides a Node.js API for controlling Xsnap workers.

```js
const worker = await xsnap({
  variant: 'latest', // default: 'legacy'
});
await worker.evaluate(`
  // Incrementer, running on XS.
  function handleCommand(message) {
    const number = parseInt(new TextDecoder().decode(message), 10);
    return new TextEncoder().encode(`${number + 1}`).buffer;
  }
`);
await fs.writeFile('bootstrap.xss', worker.makeSnapshotStream());
await worker.close();
```

## Using CI-built binaries from `xsnap-worker-binaries`

Before npm platform packages are wired, CI can consume binaries from GitHub
releases in `Agoric/xsnap-worker-binaries`.

From `packages/xsnap/`:

```bash
./scripts/use-github-release-binary.sh 0.0.0-dev /tmp/xsnap-release-assets
source /tmp/xsnap-release-assets/xsnap-binary.env
```

This sets:

- `XSNAP_WORKER` for release mode
- `XSNAP_WORKER_DEBUG` for debug mode

The script verifies SHA256 digests against the release manifest before writing
the env file.

## Package install behavior

`@agoric/xsnap` postinstall provisions **both** worker variants (see
# Compatibility):

- The **`legacy`** variant installs a prebuilt binary from GitHub releases into
  the unprefixed `xsnap-native/` tree (`yarn install:prebuilt`). This is the
  snapshot-compatible engine and is byte-for-byte the same as prior installs.
- The **`latest`** variant compiles the pinned Moddable engine from source into
  the parallel `latest/xsnap-native/` tree (`yarn build:latest`, driven by
  `src/build.js --variant latest`). Its Moddable/xsnap-native commit pins live in
  `build.env`.

The two trees never overlap: `resolveXsnapWorkerPath` in `src/xsnap.js` maps
`variant: 'legacy'` to the unprefixed tree and `variant: 'latest'` to the
`latest/` tree.

Optional environment overrides for the prebuilt (legacy) install:

- `XSNAP_BINARY_VERSION` (default: package version)
- `XSNAP_BINARY_REPO` (default: `Agoric/xsnap-worker-binaries`)
- `XSNAP_BINARY_BASE_URL` (advanced override)
- `XSNAP_BINARY_MANIFEST_SHA256` (required trust anchor for unpinned versions)
- `XSNAP_CACHE_DIR` (advanced override for cached downloads)

The from-source (latest) build honors `MODDABLE_COMMIT_HASH` /
`XSNAP_NATIVE_COMMIT_HASH` (and matching `_URL` / `_ARCHIVE_URL`) env overrides,
falling back to `build.env` pins.

Some time later, possibly on a different computer…

```js
const decoder = new TextDecoder();
const worker = await xsnap({
  snapshotStream: fs.createFileStream('bootstrap.xss'),
});
const response = await worker.issueCommand('1');
console.log(decoder.decode(response)); // 2
await worker.close();
```

The parent and child communicate using "commands".

- The XS child uses the synchronous `issueCommand` function to send a request
  and receive as response from the Node.js parent.
- The XS child can implement a synchronous `handleCommand` function to respond
  to commands from the Node.js parent.
  - The XS child `handleCommand` may be asynchronous after a fashion: it
    may return an object and, before the promise queue becomes empty,
    set the `result` property of this object to an `ArrayBuffer`.
    See the **evaluate and report** test for an example.
- The Node.js parent uses an asynchronous `issueCommand` method to send a
  request and receive a response from the XS child.
- The Node.js parent can implement an asynchronous `handleCommand` function to
  respond to commands from the XS child.

![state diagram](doc/xsnap-states.svg)

# Compatibility

The `variant` is either `"legacy"` or `"latest"`.
For purposes of backward-compatibility, the `"legacy"` variant ensures
that all future versions of `xsnap` will read snapshots created by any
prior version produced by the `"legacy"` variant.

By contrast, the `"latest"` variant should not be asked to read snapshots
produced by any previous version of `xsnap`, and in exchange, may have
new features and changes in behavior including observably different behavior
due to bug fixes.

## Testing both variants

The test suite runs against one variant per invocation, selected by the
`XSNAP_TEST_VARIANT` environment variable (`legacy` | `latest`, default
`legacy`):

```sh
yarn test                          # default 'legacy' lane (consensus engine)
XSNAP_TEST_VARIANT=latest yarn test  # 'latest' lane (XS 16.7.1 / Moddable 5.5.0)
```

The switch (see `test/message-tools.js` `TEST_VARIANT`) selects **both** which
worker binary the tests spawn and which golden set the engine-sensitive tests
assert against. The default `legacy` lane is byte-stable with master: a plain
`yarn test` reproduces the committed consensus-engine goldens with zero churn
(including the ava snapshot-hash goldens in `test/snapshots/`, which the `latest`
lane deliberately does **not** overwrite — it asserts its own recorded hashes
instead). Where the `latest` engine's metering legitimately diverges (the
run-time metering-switch precision case), that test carries an honest
`test.failing` marker under `latest` only.

<!-- FIXME this stopped working some time ago (was never in CI)
https://github.com/Agoric/agoric-sdk/issues/9955
# xsrepl

With `xsnap` comes an `xsrepl` command line tool.
Use `yarn global add @agoric/xsnap` to add `xsrepl` to your path.
During development, run `yarn repl`.

The REPL supports special commands `load` and `save` for snapshots, and `quit`
to quit.
Load and save don't take arguments; just type the file name on the next prompt.

```console
$ xsrepl
xs> globalThis.x = 42;
xs> x
42
xs> save
file> temp.xss
xs> quit
```

```console
$ xsrepl
xs> load
file> temp.xss
xs> x
42
xs> quit
```
 -->
