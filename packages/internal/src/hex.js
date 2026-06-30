/**
 * Hex transcoding for `@agoric/internal`, delegated to `@endo/hex`.
 *
 * This module used to carry an in-tree codec. It now re-exports the published
 * `@endo/hex` package, which is a tiered codec: it dispatches to the native
 * TC39 `Uint8Array.prototype.toHex` / `Uint8Array.fromHex` intrinsics
 * (proposal-arraybuffer-base64) when present, and otherwise falls through to a
 * pure-JavaScript char-code-arithmetic polyfill with bounded loops and no
 * module-scope mutable lookup table. That native→char-code tiering is
 * XS-stack-safe and avoids the `flatMap`/`Map`-construction hazards that
 * motivated the in-tree workaround this file used to carry.
 *
 * `encodeHex(bytes)` emits lowercase hex. `decodeHex(string)` accepts both
 * upper- and lowercase input and throws on odd-length strings and on any
 * character outside `[0-9a-fA-F]`.
 *
 * @see https://github.com/endojs/endo/blob/master/packages/hex/README.md
 */
export { encodeHex, decodeHex } from '@endo/hex';
