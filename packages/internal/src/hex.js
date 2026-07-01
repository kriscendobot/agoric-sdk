/**
 * Hex transcoding for `@agoric/internal`, delegated to `@endo/hex`.
 *
 * This module used to carry an in-tree codec. It now delegates to the published
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
 * The re-exported bindings carry explicit local `@type` annotations rather than
 * a bare `export { ... } from '@endo/hex'`. `@endo/hex@^1.1.1` ships no
 * TypeScript declarations, so a bare re-export leaves `@agoric/internal`'s
 * generated `hex.d.ts` pointing at an untyped module. In-repo (ambient) type
 * resolution reads the `@endo/hex` source directly and tolerates that, but the
 * packed-type resolution the `dependency-graph` job exercises (declarations
 * only, no ambient source) cannot follow the re-export and reports
 * `encodeHex`/`decodeHex` as missing exports. Annotating the bindings here makes
 * the generated declarations self-contained, so downstream packages resolve the
 * concrete signatures without needing `@endo/hex`'s (absent) types. This keeps
 * the direct bindings to the hardened `@endo/hex` functions (no wrapper frame).
 *
 * @see https://github.com/endojs/endo/blob/master/packages/hex/README.md
 */
import {
  encodeHex as endoEncodeHex,
  decodeHex as endoDecodeHex,
} from '@endo/hex';

/** @type {(bytes: Uint8Array) => string} */
export const encodeHex = endoEncodeHex;

/** @type {(hex: string) => Uint8Array} */
export const decodeHex = endoDecodeHex;
