// NB: cannot import, breaks bundle building
/* global globalThis */

import { importBundle } from '@endo/import-bundle';
import { handlePWarning } from '../handleWarning.js';

const evalContractBundle = (bundle, additionalEndowments = {}) => {
  // Make the console more verbose.
  const louderConsole = {
    ...console,
    log: console.info,
  };

  const defaultEndowments = {
    console: louderConsole,
    // See https://github.com/Agoric/agoric-sdk/issues/9515
    assert: globalThis.assert,
    VatData: globalThis.VatData,
    // SES 2.0 (endojs/endo#3153) removed Float*Array from shared compartment
    // globals as part of NaN side-channel hardening. Pre-built upstream
    // release bundles (e.g. fast-usdc-beta-1/rc1/rc2/cctp-b1) embed pre-fix
    // @endo/marshal source that still calls `new Float64Array(...)` inside
    // encodePassable, so we endow the constructors here to keep those
    // bundles deserializable. New marshal source uses DataView and does
    // not need the endowment.
    Float16Array: globalThis.Float16Array,
    Float32Array: globalThis.Float32Array,
    Float64Array: globalThis.Float64Array,
  };

  const fullEndowments = Object.create(null, {
    ...Object.getOwnPropertyDescriptors(defaultEndowments),
    ...Object.getOwnPropertyDescriptors(additionalEndowments),
  });

  // Evaluate the export function, and use the resulting
  // module namespace as our installation.

  const installation = importBundle(bundle, {
    endowments: fullEndowments,
  });
  handlePWarning(installation);
  return installation;
};

export { evalContractBundle };
