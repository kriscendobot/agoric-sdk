import { E, Far } from '@endo/far';

// Bootstrap vat driving the park-on-failed-upgrade lifecycle for
// park-on-fail.test.js. It creates a dynamic target vat, forces a failed
// upgrade under the 'park' policy, sends a message that must defer, and then
// resumes the vat by upgrade or restart.
export const buildRootObject = () => {
  let vatAdmin;
  let root;
  let adminNode;
  let deferredP; // result promise of a send issued while the vat is parked

  return Far('root', {
    bootstrap: async (vats, devices) => {
      vatAdmin = await E(vats.vatAdmin).createVatAdminService(devices.vatAdmin);
    },

    // create the target vat and bump its durable counter to 1
    build: async () => {
      const bcap = await E(vatAdmin).getNamedBundleCap('good');
      const res = await E(vatAdmin).createVat(bcap, {
        vatParameters: { label: 'v1' },
      });
      root = res.root;
      adminNode = res.adminNode;
      await E(root).bump(); // count -> 1
      return E(root).getCount();
    },

    // rollback (default) policy: a failed upgrade restores the old incarnation
    upgradeRollbackOnExplode: async () => {
      const bcap = await E(vatAdmin).getNamedBundleCap('explode');
      let message;
      await E(adminNode)
        .upgrade(bcap, { vatParameters: { explode: 'boom' } })
        .catch(e => {
          message = e.message;
        });
      // the old incarnation is back and answers normally
      const pong = await E(root).ping();
      return { message, pong };
    },

    // park policy: a failed upgrade parks the vat instead of rolling back
    upgradeParkOnExplode: async () => {
      const bcap = await E(vatAdmin).getNamedBundleCap('explode');
      let message;
      await E(adminNode)
        .upgrade(bcap, {
          vatParameters: { explode: 'boom' },
          onUpgradeFailure: 'park',
        })
        .catch(e => {
          message = e.message;
        });
      return message;
    },

    // issue a send to the (parked) vat without awaiting it; it must defer
    sendDeferredBump: () => {
      deferredP = E(root).bump();
      deferredP.then(
        () => {},
        () => {},
      );
      return 'sent';
    },

    parkStatus: () => E(adminNode).parkStatus(),

    // resume by upgrade onto the good bundle; the deferred bump drains ahead of
    // this method's own getCount(), so a return of 2 proves FIFO drain
    resumeByUpgrade: async () => {
      const bcap = await E(vatAdmin).getNamedBundleCap('good');
      await E(adminNode).upgrade(bcap, { vatParameters: { label: 'v2' } });
      return E(root).getCount();
    },

    // resume by restart (snapshot + replay of the retained transcript)
    resumeByRestart: async () => {
      await E(adminNode).restart();
      return E(root).getCount();
    },

    // await the deferred send's result (used after a resume)
    getDeferredResult: () => deferredP,
  });
};
