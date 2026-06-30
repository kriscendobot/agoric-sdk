// @ts-check
import test from 'ava';

import { encodeHex, decodeHex } from '../src/hex.js';

/**
 * `@agoric/internal/src/hex.js` is a thin re-export of `@endo/hex`. These tests
 * pin the behavior `@agoric/internal`'s callers rely on: full 0..255
 * round-trip, upper/lower-case acceptance, lowercase-normalizing encode, empty
 * input, and rejection of odd-length and non-hex input. The error text follows
 * `@endo/hex`'s semantics (odd length vs. invalid character with offset) rather
 * than the literal message the in-tree codec used to throw; no caller in this
 * tree depends on the old string.
 */

/** @type {Array<[string, number[]]>} valid input -> expected bytes */
const validCases = [
  ['', []],
  ['00', [0x00]],
  ['41', [0x41]],
  ['ff', [0xff]],
  ['deadbeef', [0xde, 0xad, 0xbe, 0xef]],
  ['DEADBEEF', [0xde, 0xad, 0xbe, 0xef]],
  ['DeAdBeEf', [0xde, 0xad, 0xbe, 0xef]],
  ['0a0B', [0x0a, 0x0b]],
];

/** Odd-length inputs: rejected for length before any character is inspected. */
const oddLengthCases = [
  'f', // single nibble
  'abc', // odd length with a valid prefix
  '012', // odd length
  '12 34', // length 5 (embedded whitespace)
];

/** Even-length inputs that contain a non-hex character. */
const invalidCharCases = [
  'zz', // non-hex characters
  'GG', // non-hex uppercase
  'gg', // non-hex lowercase
  'xy', // non-hex characters
  'abxc', // non-hex character mid-string
  'abcx', // non-hex character at the tail of an even-length string
  '0x41', // hex literal prefix is not valid hex
];

for (const [hex, bytes] of validCases) {
  test(`decodeHex accepts valid input ${JSON.stringify(hex)}`, t => {
    t.deepEqual([...decodeHex(hex)], bytes);
  });
}

for (const hex of oddLengthCases) {
  test(`decodeHex rejects odd-length input ${JSON.stringify(hex)}`, t => {
    t.throws(() => decodeHex(hex), { message: /even length/ });
  });
}

for (const hex of invalidCharCases) {
  test(`decodeHex rejects non-hex input ${JSON.stringify(hex)}`, t => {
    t.throws(() => decodeHex(hex), { message: /Invalid hex character/ });
  });
}

test('encodeHex round-trips and normalizes to lowercase', t => {
  for (const [hex] of validCases) {
    const round = encodeHex(decodeHex(hex));
    t.is(round, hex.toLowerCase());
  }
});

test('round-trips every byte value 0..255', t => {
  const all = Uint8Array.from({ length: 256 }, (_, b) => b);
  t.deepEqual([...decodeHex(encodeHex(all))], [...all]);
});

test('@ and backtick guards: even-length input with those chars is rejected', t => {
  // `@` (0x40) sits just below 'A' (0x41); backtick (0x60) just below 'a'
  // (0x61). The char-code arithmetic must not admit either as a hex digit.
  t.throws(() => decodeHex('@@'), { message: /Invalid hex character/ });
  t.throws(() => decodeHex('``'), { message: /Invalid hex character/ });
});
