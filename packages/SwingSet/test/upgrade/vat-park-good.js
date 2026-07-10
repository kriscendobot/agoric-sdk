import { Far } from '@endo/far';

// A minimal upgradeable target vat used by park-on-fail.test.js. It keeps a
// single durable counter in baggage (no durable kinds to reattach), so it
// upgrades cleanly and is also a valid resume target. Serves as both the
// initial incarnation and the "good" bundle a parked vat is resumed onto.
export const buildRootObject = (_vatPowers, vatParameters, baggage) => {
  const label = (vatParameters && vatParameters.label) || 'good';
  if (!baggage.has('count')) {
    baggage.init('count', 0);
  }
  return Far('root', {
    getLabel: () => label,
    ping: () => 'pong',
    // bump() mutates durable state, so a deferred bump is observable after
    // resume via getCount()
    bump: () => {
      const next = baggage.get('count') + 1;
      baggage.set('count', next);
      return next;
    },
    getCount: () => baggage.get('count'),
  });
};
