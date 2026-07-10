import { assert, Fail } from '@endo/errors';
import { kser, kunser } from '@agoric/kmarshal';
import { insistVatID } from '../lib/id.js';

export function makeVatAdminHooks(tools) {
  const { kernelKeeper, terminateVat } = tools;
  return {
    createByBundle(argsCapData) {
      // first, split off vatParameters
      const args = kunser(argsCapData);
      const [bundle, { vatParameters, ...dynamicOptions }] = args;
      // assemble the vatParameters capdata
      const marshalledVatParameters = kser(vatParameters);
      // incref slots while create-vat is on run-queue
      for (const kref of marshalledVatParameters.slots) {
        kernelKeeper.incrementRefCount(kref, 'create-vat-event');
      }
      const source = { bundle };
      const vatID = kernelKeeper.allocateUnusedVatID();
      const event = {
        type: 'create-vat',
        vatID,
        source,
        vatParameters: marshalledVatParameters,
        dynamicOptions,
      };
      kernelKeeper.addToAcceptanceQueue(harden(event));
      // the device gets the new vatID immediately, and will be notified
      // later when it is created and a root object is available
      return harden(kser(vatID));
    },

    createByID(argsCapData) {
      // `argsCapData` is marshal([bundleID, options]), and `options` is {
      // vatParameters, ...rest }, and `rest` is checked by vat-vat-admin.js to
      // contain only known keys and types, none of which allow slots.  So any
      // slots in `argsCapData` will be associated with `vatParameters`.

      // first, split off vatParameters
      const args = kunser(argsCapData);
      const [bundleID, { vatParameters, ...dynamicOptions }] = args;
      assert(kernelKeeper.hasBundle(bundleID), bundleID);
      // assemble the marshalled vatParameters
      const marshalledVatParameters = kser(vatParameters);
      // incref slots while create-vat is on run-queue
      for (const kref of marshalledVatParameters.slots) {
        kernelKeeper.incrementRefCount(kref, 'create-vat-event');
      }
      const source = { bundleID };
      const vatID = kernelKeeper.allocateUnusedVatID();
      const event = {
        type: 'create-vat',
        vatID,
        source,
        vatParameters: marshalledVatParameters,
        dynamicOptions,
      };
      kernelKeeper.addToAcceptanceQueue(harden(event));
      // the device gets the new vatID immediately, and will be notified
      // later when it is created and a root object is available
      return harden(kser(vatID));
    },

    upgrade(argsCapData) {
      // marshal([vatID, bundleID, vatParameters, upgradeMessage,
      //          onUpgradeFailure?]) -> upgradeID
      const args = kunser(argsCapData);
      const [vatID, bundleID, vatParameters, upgradeMessage, onUpgradeFailure] =
        args;
      insistVatID(vatID);
      assert.typeof(bundleID, 'string');
      assert.typeof(upgradeMessage, 'string');
      // onUpgradeFailure selects rollback (default, today's behavior) vs park
      // (degrade the vat into a reversible parked state) when the upgrade fails
      if (onUpgradeFailure !== undefined) {
        assert(
          onUpgradeFailure === 'rollback' || onUpgradeFailure === 'park',
          `invalid onUpgradeFailure ${onUpgradeFailure}`,
        );
      }
      const marshalledVatParameters = kser(vatParameters);
      for (const kref of marshalledVatParameters.slots) {
        kernelKeeper.incrementRefCount(kref, 'upgrade-vat-event');
      }
      const upgradeID = kernelKeeper.allocateUpgradeID();
      const ev = {
        type: 'upgrade-vat',
        vatID,
        upgradeID,
        bundleID,
        vatParameters: marshalledVatParameters,
        upgradeMessage,
        onUpgradeFailure: onUpgradeFailure || 'rollback',
      };
      kernelKeeper.addToAcceptanceQueue(harden(ev));
      return harden(kser(upgradeID));
    },

    restart(argsCapData) {
      // marshal([vatID]) -> undefined. Resume a parked vat by snapshot+replay:
      // move its deferred deliveries back onto the acceptance queue
      // (refcount-neutral) and lift the parked flag, so the next delivery
      // re-creates the worker from its retained snapshot + transcript. If
      // replay diverges again the vat re-parks (detection hook 2).
      const [vatID] = kunser(argsCapData);
      insistVatID(vatID);
      kernelKeeper.vatIsParked(vatID) || Fail`vat ${vatID} is not parked`;
      for (
        let ev = kernelKeeper.getNextParkQueueMsg(vatID);
        ev !== undefined;
        ev = kernelKeeper.getNextParkQueueMsg(vatID)
      ) {
        kernelKeeper.addToAcceptanceQueue(harden(ev));
      }
      kernelKeeper.unparkVat(vatID);
      return harden(kser(undefined));
    },

    parkStatus(argsCapData) {
      // marshal([vatID]) -> { parked, reason, phase, incarnation }
      const [vatID] = kunser(argsCapData);
      insistVatID(vatID);
      const parked = kernelKeeper.vatIsParked(vatID);
      const record = parked
        ? kernelKeeper.getParkedVatRecord(vatID)
        : undefined;
      const status = {
        parked,
        reason: record ? record.reason : undefined,
        phase: record ? record.phase : undefined,
        incarnation: record ? record.incarnation : undefined,
      };
      return harden(kser(status));
    },

    terminate(argsCapData) {
      // marshal([vatID, reason]) -> null
      const args = kunser(argsCapData);
      const [vatID, reason] = args;
      insistVatID(vatID);
      const marshalledReason = kser(reason);
      // we don't need to incrementRefCount because if terminateVat sends
      // 'reason' to vat-admin, it uses notifyTermination / queueToKref /
      // doSend, and doSend() does its own incref
      // FIXME: This assumes that most work of terminateVat happens in the
      // synchronous prelude, which should be made more obvious. For details,
      // see https://github.com/Agoric/agoric-sdk/pull/10055#discussion_r1754918394
      void terminateVat(vatID, true, marshalledReason);
      // TODO: terminateVat is async, result doesn't fire until worker
      // is dead. To fix this we'll probably need to move termination
      // to a run-queue ['terminate-vat', vatID] event, like createVat
      return harden(kser(undefined));
    },

    changeOptions(argsCapData) {
      // marshal([vatID, options]) -> null
      assert(argsCapData.slots.length === 0);
      const args = kunser(argsCapData);
      const [vatID, options] = args;
      insistVatID(vatID);
      const ev = {
        type: 'changeVatOptions',
        vatID,
        options,
      };
      kernelKeeper.addToAcceptanceQueue(harden(ev));
      return harden(kser(undefined));
    },
  };
}
