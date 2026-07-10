// @ts-nocheck
// eslint-disable-next-line import/order
import { test } from '../../tools/prepare-test-env-ava.js';

import { assert } from '@endo/errors';
import { kunser } from '@agoric/kmarshal';
import { initSwingStore } from '@agoric/swing-store';
import { buildKernelBundles, makeSwingsetController } from '../../src/index.js';
import { initializeTestSwingset as initializeSwingset } from '../../tools/test-swingset.js';
import { bundleOpts } from '../util.js';

const bfile = name => new URL(name, import.meta.url).pathname;

test.before(async t => {
  const kernelBundles = await buildKernelBundles();
  t.context.data = { kernelBundles };
});

const makeConfig = () => ({
  includeDevDependencies: true, // for vat-data / baggage
  bootstrap: 'bootstrap',
  defaultManagerType: 'local',
  vats: { bootstrap: { sourceSpec: bfile('bootstrap-park.js') } },
  bundles: {
    good: { sourceSpec: bfile('vat-park-good.js') },
    explode: { sourceSpec: bfile('vat-park-explode.js') },
  },
});

const initKernel = async (t, config) => {
  const { kernelStorage } = initSwingStore();
  const { kvStore } = kernelStorage;
  const { initOpts, runtimeOpts } = bundleOpts(t.context.data);
  await initializeSwingset(config, [], kernelStorage, initOpts);
  const c = await makeSwingsetController(kernelStorage, {}, runtimeOpts);
  t.teardown(c.shutdown);
  c.pinVatRoot('bootstrap');
  await c.run();
  const messageToVat = async (vatName, method, ...args) => {
    const kpid = c.queueToVatRoot(vatName, method, args);
    await c.run();
    const status = c.kpStatus(kpid);
    if (status === 'fulfilled') {
      return kunser(c.kpResolution(kpid));
    }
    assert(status === 'rejected');
    throw kunser(c.kpResolution(kpid));
  };
  return { controller: c, kvStore, messageToVat };
};

test('rollback is the default policy on failed upgrade', async t => {
  const { messageToVat } = await initKernel(t, makeConfig());
  t.is(await messageToVat('bootstrap', 'build'), 1);

  const { message, pong } = await messageToVat(
    'bootstrap',
    'upgradeRollbackOnExplode',
  );
  t.regex(message, /vat-upgrade failure/);
  // the OLD incarnation was restored (not parked) and answers normally
  t.is(pong, 'pong');

  const status = await messageToVat('bootstrap', 'parkStatus');
  t.false(status.parked);
});

test('park on failed upgrade, resume by upgrade drains deferred deliveries', async t => {
  const { messageToVat, kvStore } = await initKernel(t, makeConfig());
  t.is(await messageToVat('bootstrap', 'build'), 1);

  // a failed upgrade under the 'park' policy parks the vat; the upgrader's
  // promise still rejects with the upgrade-failure error
  const message = await messageToVat('bootstrap', 'upgradeParkOnExplode');
  t.regex(message, /vat-upgrade failure/);

  const status = await messageToVat('bootstrap', 'parkStatus');
  t.true(status.parked);
  t.is(status.reason, 'vat-upgrade failure');
  t.is(status.phase, 'upgrade');
  t.is(typeof status.incarnation, 'number');

  // the parked vat is recorded in kernel state
  t.deepEqual(JSON.parse(kvStore.get('vats.parked')).length, 1);

  // a send to the parked vat defers (does not settle) — no error contract leaks
  t.is(await messageToVat('bootstrap', 'sendDeferredBump'), 'sent');

  // resume by upgrade: the deferred bump drains FIFO ahead of this method's own
  // getCount(), so a returned count of 2 proves the deferral drained in order
  t.is(await messageToVat('bootstrap', 'resumeByUpgrade'), 2);

  // the deferred send has now settled to the post-drain value
  t.is(await messageToVat('bootstrap', 'getDeferredResult'), 2);

  // the vat is no longer parked, and the kernel park set is empty again
  t.false((await messageToVat('bootstrap', 'parkStatus')).parked);
  t.deepEqual(JSON.parse(kvStore.get('vats.parked')), []);
});

test('park on failed upgrade, resume by restart replays and drains', async t => {
  const { messageToVat } = await initKernel(t, makeConfig());
  t.is(await messageToVat('bootstrap', 'build'), 1);
  t.regex(
    await messageToVat('bootstrap', 'upgradeParkOnExplode'),
    /vat-upgrade failure/,
  );
  t.true((await messageToVat('bootstrap', 'parkStatus')).parked);
  t.is(await messageToVat('bootstrap', 'sendDeferredBump'), 'sent');

  // restart resumes by snapshot + replay; the deferred bump drains, count -> 2
  t.is(await messageToVat('bootstrap', 'resumeByRestart'), 2);
  t.false((await messageToVat('bootstrap', 'parkStatus')).parked);
});
