// @ts-nocheck

// eslint-disable-next-line import/order
import { test } from '../tools/prepare-test-env-ava.js';

import { initSwingStore } from '@agoric/swing-store';

import { promoteVatsToCritical } from '../src/index.js';
import { initializeTestSwingset as initializeSwingset } from '../tools/test-swingset.js';
import { buildKernelBundles } from '../src/index.js';

// PROTOTYPE (kriskowal/garden#29). These tests exercise promoteVatsToCritical
// at the same kvStore-fixture level the upgradeSwingset() migrations are tested
// at (see upgrade-swingset.test.js): initialize a swingset, doctor the kvStore
// to look like a chain that is running the ymax portfolio vat, run the
// promotion, and assert the `critical` bit flipped in `${vatID}.options`.
//
// ymax is a *dynamic* contract vat, so the discovery path under test is the
// dynamic one: a vatID listed in `vat.dynamicIDs` whose options blob carries a
// label. We inject a synthetic dynamic-vat record (id + options), matching how
// upgrade-swingset.test.js doctors per-vat state directly. The downstream
// "a critical vat's death panics the kernel" behavior is already covered by
// packages/SwingSet/test/vat-admin/terminate/terminate.test.js (doTerminateCritical);
// this file covers only the promotion itself.

test.before(async t => {
  const kernelBundles = await buildKernelBundles();
  t.context.data = { kernelBundles };
});

/**
 * Initialize a minimal swingset and inject a synthetic dynamic vat with the
 * given label into the kvStore, returning helpers plus the injected vatID.
 *
 * @param {*} t
 * @param {string} vatID
 * @param {string} label
 * @param {boolean} [critical]
 */
const setupWithDynamicVat = async (t, vatID, label, critical = false) => {
  const { hostStorage, kernelStorage } = initSwingStore();
  const { commit } = hostStorage;
  const { kvStore } = kernelStorage;
  await initializeSwingset({}, [], kernelStorage, t.context.data);

  // Inject a synthetic dynamic vat: an id on vat.dynamicIDs plus an options
  // blob carrying the label and the critical flag. (We do not build a
  // controller over this fake vat; the promotion works purely on kvStore.)
  const dynamicIDs = JSON.parse(kvStore.get('vat.dynamicIDs') || '[]');
  dynamicIDs.push(vatID);
  kvStore.set('vat.dynamicIDs', JSON.stringify(dynamicIDs));
  kvStore.set(
    `${vatID}.options`,
    JSON.stringify({
      name: label,
      workerOptions: { type: 'local' },
      critical,
    }),
  );
  await commit();
  return { hostStorage, kernelStorage, kvStore, commit };
};

const readCritical = (kvStore, vatID) =>
  JSON.parse(kvStore.get(`${vatID}.options`)).critical;

test('label mode: promotes a dynamic vat discovered by label suffix', async t => {
  // real ymax contract vats are labelled like `zcf-b1-<hash>-ymax1`
  const { kvStore } = await setupWithDynamicVat(t, 'v99', 'zcf-b1-abcd-ymax1');
  t.is(readCritical(kvStore, 'v99'), false);

  const result = promoteVatsToCritical(
    { kvStore },
    { targets: [{ name: 'ymax1' }] },
  );

  t.deepEqual(result.notFound, []);
  t.is(result.promoted.length, 1);
  t.is(result.promoted[0].vatID, 'v99');
  t.is(result.promoted[0].wasCritical, false);
  t.is(readCritical(kvStore, 'v99'), true);
});

test('chainID mode: agoric-3 selects ymax1 and pins v288', async t => {
  const { kvStore } = await setupWithDynamicVat(t, 'v288', 'zcf-b1-abcd-ymax1');
  const result = promoteVatsToCritical({ kvStore }, { chainID: 'agoric-3' });
  t.is(result.promoted.length, 1);
  t.is(result.promoted[0].vatID, 'v288');
  t.is(readCritical(kvStore, 'v288'), true);
});

test('chainID mode: agoricdev-25 selects ymax0 and pins v320', async t => {
  const { kvStore } = await setupWithDynamicVat(t, 'v320', 'zcf-b1-wxyz-ymax0');
  const result = promoteVatsToCritical(
    { kvStore },
    { chainID: 'agoricdev-25' },
  );
  t.is(result.promoted.length, 1);
  t.is(result.promoted[0].vatID, 'v320');
  t.is(readCritical(kvStore, 'v320'), true);
});

test('idempotent: a second run leaves an already-critical vat untouched', async t => {
  const { kvStore } = await setupWithDynamicVat(t, 'v99', 'my-ymax1');
  promoteVatsToCritical({ kvStore }, { targets: [{ name: 'ymax1' }] });
  t.is(readCritical(kvStore, 'v99'), true);

  const second = promoteVatsToCritical(
    { kvStore },
    { targets: [{ name: 'ymax1' }] },
  );
  t.is(second.promoted.length, 1);
  t.is(second.promoted[0].wasCritical, true); // reports it was already critical
  t.is(readCritical(kvStore, 'v99'), true);
});

test('no-op on an unrelated chain', async t => {
  const { kvStore } = await setupWithDynamicVat(t, 'v99', 'zcf-b1-abcd-ymax1');
  const result = promoteVatsToCritical({ kvStore }, { chainID: 'agoriclocal' });
  t.deepEqual(result.promoted, []);
  t.is(readCritical(kvStore, 'v99'), false); // untouched
});

test('reports notFound when the target label is absent', async t => {
  const { kvStore } = await setupWithDynamicVat(t, 'v99', 'some-other-vat');
  const result = promoteVatsToCritical(
    { kvStore },
    { targets: [{ name: 'ymax1' }] },
  );
  t.deepEqual(result.promoted, []);
  t.is(result.notFound.length, 1);
  t.is(result.notFound[0].name, 'ymax1');
});

test('pinned vatID with a mismatched label is rejected', async t => {
  // v288 exists but is NOT the ymax1 vat: the safety assertion must fire.
  const { kvStore } = await setupWithDynamicVat(t, 'v288', 'not-the-ymax-vat');
  t.throws(() => promoteVatsToCritical({ kvStore }, { chainID: 'agoric-3' }), {
    message: /expected .*ymax1/,
  });
  t.is(readCritical(kvStore, 'v288'), false); // not promoted
});
