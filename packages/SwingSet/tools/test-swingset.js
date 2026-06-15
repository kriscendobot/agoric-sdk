/* eslint-env node */
import { makeReadJsonFile } from '@agoric/internal/src/node/read-json.js';
import fs from 'node:fs';
import {
  buildSwingsetKernelConfig,
  initializeSwingsetKernel,
} from '../src/controller/initializeSwingset.js';
import { unsafeSharedBundleCache } from './bundleTool.js';

/**
 * @import {BundleSourceResult} from '@endo/bundle-source';
 * @import {SwingSetConfig, SwingStoreKernelStorage} from '../src/types-external.js';
 * @import {InitializationOptions, InitializeSwingsetRuntimeOptions} from '../src/controller/initializeSwingset.js';
 */

const readBundleSpecFile = makeReadJsonFile(fs.promises);

/**
 * Test-only wrapper that supplies ambient-powered bundleSpec loading.
 *
 * @param {Omit<SwingSetConfig, 'bundleCachePath' | 'bundleFormat' | 'includeDevDependencies'>} config
 * @param {unknown} bootstrapArgs
 * @param {SwingStoreKernelStorage} kernelStorage
 * @param {InitializationOptions} initializationOptions
 * @param {InitializeSwingsetRuntimeOptions} runtimeOptions
 */
export const initializeTestSwingset = async (
  config,
  bootstrapArgs,
  kernelStorage,
  initializationOptions = {},
  runtimeOptions = {},
) => {
  const cache = await unsafeSharedBundleCache;

  const kernelConfig = await buildSwingsetKernelConfig(
    config,
    bootstrapArgs,
    initializationOptions,
    {
      ...runtimeOptions,
      bundleFromPath: runtimeOptions.bundleFromPath || readBundleSpecFile,
      bundleFromSourceSpec: (sourceSpec, _options) =>
        /** @type {Promise<BundleSourceResult<'endoZipBase64'>>} */ (
          cache.load(sourceSpec)
        ),
    },
  );
  return initializeSwingsetKernel(kernelConfig, kernelStorage, runtimeOptions);
};
