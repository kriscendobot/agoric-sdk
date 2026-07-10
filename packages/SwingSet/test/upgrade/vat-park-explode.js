// The "bad" bundle for park-on-fail.test.js: its upgrade phase throws, which
// fails the startVat delivery and drives processUpgradeVat's abort branch —
// where onUpgradeFailure: 'park' parks the vat instead of rolling back.
export const buildRootObject = (_vatPowers, vatParameters, _baggage) => {
  throw Error((vatParameters && vatParameters.explode) || 'kaboom');
};
