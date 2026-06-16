import anylogger from '@agoric/internal/vendor/anylogger.js';

const oldExt = anylogger.ext;

/**
 * Restore the pre-vendoring default: enabled levels log to console.
 *
 * @param {Record<string, unknown>} logger
 * @param {...unknown} rest
 */
// @ts-expect-error Adapter signature accepts a LogFunction but vendor
// override extends with additional sink wiring.
anylogger.ext = (logger, ...rest) => {
  // @ts-expect-error oldExt is typed as Adapter (logfn) => Logger; legacy
  // wiring forwards the wider (logger, ...rest) tuple intentionally.
  const extended = oldExt(logger, ...rest);
  const fallbackSink = console.log.bind(console);

  extended.enabledFor = level =>
    level !== undefined && level in anylogger.levels;
  for (const level of Object.keys(anylogger.levels)) {
    extended[level] =
      (typeof console[level] === 'function' && console[level].bind(console)) ||
      fallbackSink;
  }
  return extended;
};
