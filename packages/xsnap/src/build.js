#!/usr/bin/env node
/* eslint-env node */
import * as childProcessTop from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsTop from 'node:fs';
import osTop from 'node:os';

/**
 * @import {spawn} from 'node:child_process';
 * @import {ChildProcess} from 'node:child_process';
 * @import {promises} from 'node:fs';
 */

const { freeze } = Object;

/** @param {string} path */
const asset = path => fileURLToPath(new URL(path, import.meta.url));

/** @typedef {{ path: string, make?: string }} ModdablePlatform */

const ModdableSDK = {
  // The Moddable/xsnap-native source trees are variant-specific and resolved
  // per-build in main() (see variantPrefix); see resolveXsnapWorkerPath in
  // xsnap.js for the matching binary-path split.
  /** @type { Record<string, ModdablePlatform>} */
  platforms: {
    Linux: { path: 'lin' },
    Darwin: { path: 'mac' },
  },
  buildGoals: ['release', 'debug'],
};

/**
 * Create promise-returning functions for asynchronous execution of no-input
 * commands.
 *
 * @param {string} command
 * @param {{
 *   spawn: typeof spawn,
 * }} io
 */
function makeCLI(command, { spawn }) {
  /** @param {ChildProcess} child */
  const wait = child =>
    new Promise((resolve, reject) => {
      child.on('close', () => {
        resolve(undefined);
      });
      child.on('error', err => {
        reject(Error(`${command} error ${err}`));
      });
      child.on('exit', code => {
        if (code !== 0) {
          reject(Error(`${command} exited with code ${code}`));
        }
      });
    });

  return freeze({
    /**
     * Run the command, writing directly to stdout and stderr.
     *
     * @param {string[]} args
     * @param {{ cwd?: string }} [opts]
     */
    run: (args, opts) => {
      const { cwd = '.' } = opts || {};
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      return wait(child);
    },
    /**
     * Run the command, writing directly to stderr but capturing and returning
     * stdout.
     *
     * @param {string[]} args
     * @param {{ cwd?: string, fullOutput?: boolean }} [opts]
     * @returns {Promise<string>} command output, stripped of trailing
     *   whitespace unless option "fullOutput" is true
     */
    pipe: async (args, opts) => {
      const { cwd = '.', fullOutput = false } = opts || {};
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      await wait(child);
      const output = Buffer.concat(chunks).toString('utf8');
      return fullOutput ? output : output.trimEnd();
    },
  });
}

/** @param {string} repoUrl */
const canonicalRepoUrl = repoUrl =>
  repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');

/**
 * @param {string} repoUrl
 * @param {string} commitHash
 */
const defaultArchiveUrl = (repoUrl, commitHash) =>
  `${canonicalRepoUrl(repoUrl)}/archive/${commitHash}.tar.gz`;

const SOURCE_STAMP_FILE = '.agoric-source-stamp.json';

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
const parseEnvText = text => {
  /** @type {Record<string, string>} */
  const envMap = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);
    envMap[key] = value;
  }
  return envMap;
};

/**
 * @typedef {{
 *   url: string,
 *   path: string,
 *   commitHash: string,
 *   archiveUrl: string,
 *   envPrefix: string,
 * }} SourceDescriptor
 */

/**
 * @param {SourceDescriptor[]} sources
 * @param {{
 *   stdout: typeof process.stdout,
 * }} io
 */
const showEnv = async (sources, { stdout }) => {
  await null;
  for (const { envPrefix, url, commitHash, archiveUrl } of sources) {
    stdout.write(`${envPrefix}URL=${url}\n`);
    stdout.write(`${envPrefix}COMMIT_HASH=${commitHash}\n`);
    const defaultUrl = defaultArchiveUrl(url, commitHash);
    if (archiveUrl && archiveUrl !== defaultUrl) {
      stdout.write(`${envPrefix}ARCHIVE_URL=${archiveUrl}\n`);
    }
  }
};

/**
 * @param {SourceDescriptor[]} sources
 * @param {{
 *   fs: Pick<typeof import('fs'), 'existsSync'> &
 *     Pick<typeof promises, 'mkdir' | 'rm' | 'readFile' | 'writeFile' | 'rename'>,
 *   curl: ReturnType<typeof makeCLI>,
 *   tar: ReturnType<typeof makeCLI>,
 * }} io
 */
const updateSources = async (sources, { fs, curl, tar }) => {
  await null;
  for (const { archiveUrl, path, commitHash, url } of sources) {
    const stamp = JSON.stringify({ url, commitHash, archiveUrl }, null, 2);
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    const oldPath = `${path}.old.${process.pid}.${Date.now()}`;
    const archivePath = `${tmpPath}.tar.gz`;
    const hadExistingPath = fs.existsSync(path);

    await fs.rm(tmpPath, { recursive: true, force: true });
    await fs.rm(oldPath, { recursive: true, force: true });
    await fs.mkdir(tmpPath, { recursive: true });

    try {
      await curl.run(['-fsSL', archiveUrl, '-o', archivePath]);
      await tar.run([
        '-xzf',
        archivePath,
        '--strip-components=1',
        '-C',
        tmpPath,
      ]);
      await fs.writeFile(`${tmpPath}/${SOURCE_STAMP_FILE}`, `${stamp}\n`);

      if (hadExistingPath) {
        await fs.rename(path, oldPath);
      }

      try {
        await fs.rename(tmpPath, path);
      } catch (err) {
        if (hadExistingPath && fs.existsSync(oldPath)) {
          await fs.rename(oldPath, path);
        }
        throw err;
      }
    } catch (err) {
      throw Error(
        `Failed to fetch archive for ${path} @ ${commitHash} from ${archiveUrl}: ${err}`,
      );
    } finally {
      await fs.rm(archivePath, { force: true });
      await fs.rm(tmpPath, { recursive: true, force: true });
      await fs.rm(oldPath, { recursive: true, force: true });
    }
  }
};

/**
 * @param {ModdablePlatform} platform
 * @param {boolean} force
 * @param {string} moddablePath
 * @param {string} variantPrefix
 * @param {{
 *   fs: Pick<typeof import('fs'), 'existsSync'> &
 *     Pick<typeof promises, 'readFile' | 'writeFile'>,
 *   make: ReturnType<typeof makeCLI>,
 * }} io
 */
const buildXsnap = async (
  platform,
  force,
  moddablePath,
  variantPrefix,
  { fs, make },
) => {
  const pjson = await fs.readFile(asset('../package.json'), 'utf-8');
  const pkg = JSON.parse(pjson);

  const configEnvs = [
    `XSNAP_VERSION=${pkg.version}`,
    `CC=cc "-D__has_builtin(x)=1"`,
  ];

  const configEnvFile = asset('../build.config.env');
  const existingConfigEnvs = fs.existsSync(configEnvFile)
    ? await fs.readFile(configEnvFile, 'utf-8')
    : '';

  const expectedConfigEnvs = configEnvs.concat('').join('\n');
  if (force || existingConfigEnvs.trim() !== expectedConfigEnvs.trim()) {
    await fs.writeFile(configEnvFile, expectedConfigEnvs);
  }

  for (const goal of ModdableSDK.buildGoals) {
    await make.run(
      [
        `MODDABLE=${moddablePath}`,
        `GOAL=${goal}`,
        // Any other configuration variables that affect the build output
        // should be placed in `configEnvs` to force a rebuild if they change
        ...configEnvs,
        `EXTRA_DEPS=${configEnvFile}`,
        '-f',
        'xsnap-worker.mk',
      ],
      {
        cwd: `${variantPrefix}xsnap-native/xsnap/makefiles/${platform.path}`,
      },
    );
  }
};

/**
 * @param {string[]} args
 * @param {{
 *   env: Record<string, string | undefined>,
 *   stdout: typeof process.stdout,
 *   spawn: typeof spawn,
 *   fs: Pick<typeof import('fs'), 'existsSync'> &
 *     Pick<typeof promises, 'readFile' | 'writeFile' | 'mkdir' | 'rm' | 'rename'>,
 *   os: Pick<typeof import('os'), 'type'>,
 * }} io
 */
async function main(args, { env, stdout, spawn, fs, os }) {
  // I solemnly swear I will do no synchronous work followed by a variable
  // number turns of the event loop.
  await null;

  const osType = os.type();
  const platform = ModdableSDK.platforms[osType];
  if (!platform) {
    throw Error(`xsnap does not support OS ${osType}`);
  }

  // The `--variant` selects which xsnap train this build produces and, with it,
  // the source/binary subtree. 'legacy' (the default) builds the unprefixed
  // `../{moddable,xsnap-native}` trees — the snapshot-compatible engine also
  // served by the prebuilt install. 'latest' builds a parallel `../latest/…`
  // subtree, matching resolveXsnapWorkerPath's split in xsnap.js. The pins are
  // read from `build.<variant>.env` when present, otherwise `build.env`.
  const variantIndex = args.indexOf('--variant');
  const variant =
    variantIndex >= 0 && args[variantIndex + 1] === 'latest'
      ? 'latest'
      : 'legacy';
  const variantPrefix = variant === 'latest' ? 'latest/' : '';
  const moddablePath = asset(`../${variantPrefix}moddable`);
  const xsnapNativePath = asset(`../${variantPrefix}xsnap-native`);

  const curl = makeCLI('curl', { spawn });
  const tar = makeCLI('tar', { spawn });
  const make = makeCLI(platform.make || 'make', { spawn });

  /** @type {Record<string, string>} */
  let pinnedEnvFromFile = {};
  let hasPinnedEnvFile = false;
  for (const pinFile of [`../build.${variant}.env`, '../build.env']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fs.readFile(asset(pinFile), 'utf-8');
      pinnedEnvFromFile = parseEnvText(text);
      hasPinnedEnvFile = true;
      break;
    } catch (_err) {
      // Try the next candidate; explicit env overrides can run without a file.
    }
  }

  const moddableUrl =
    env.MODDABLE_URL ||
    pinnedEnvFromFile.MODDABLE_URL ||
    'https://github.com/agoric-labs/moddable.git';
  const moddableCommitHash =
    env.MODDABLE_COMMIT_HASH || pinnedEnvFromFile.MODDABLE_COMMIT_HASH;
  if (!moddableCommitHash) {
    throw Error(
      'Missing MODDABLE_COMMIT_HASH; set it in env or packages/xsnap/build.env',
    );
  }

  const xsnapNativeUrl =
    env.XSNAP_NATIVE_URL ||
    pinnedEnvFromFile.XSNAP_NATIVE_URL ||
    'https://github.com/agoric-labs/xsnap-pub';
  const xsnapNativeCommitHash =
    env.XSNAP_NATIVE_COMMIT_HASH || pinnedEnvFromFile.XSNAP_NATIVE_COMMIT_HASH;
  if (!xsnapNativeCommitHash) {
    throw Error(
      'Missing XSNAP_NATIVE_COMMIT_HASH; set it in env or packages/xsnap/build.env',
    );
  }

  // When changing/adding entries here, make sure to search the whole project
  // for `@@AGORIC_DOCKER_SUBMODULES@@` in container build wiring.
  /** @type {SourceDescriptor[]} */
  const sources = [
    {
      url: moddableUrl,
      path: moddablePath,
      commitHash: moddableCommitHash,
      archiveUrl:
        env.MODDABLE_ARCHIVE_URL ||
        defaultArchiveUrl(moddableUrl, moddableCommitHash),
      envPrefix: 'MODDABLE_',
    },
    {
      url: xsnapNativeUrl,
      path: xsnapNativePath,
      commitHash: xsnapNativeCommitHash,
      archiveUrl:
        env.XSNAP_NATIVE_ARCHIVE_URL ||
        defaultArchiveUrl(xsnapNativeUrl, xsnapNativeCommitHash),
      envPrefix: 'XSNAP_NATIVE_',
    },
  ];

  // We build both release and debug executables, so checking for only the
  // former is fine.
  const bin = asset(
    `../${variantPrefix}xsnap-native/xsnap/build/bin/${platform.path}/release/xsnap-worker`,
  );
  /** @type {Map<string, SourceDescriptor>} */
  const sourceByPrefix = new Map(
    sources.map(source => [source.envPrefix, source]),
  );

  /**
   * @param {SourceDescriptor} source
   * @returns {Promise<boolean>} whether the source needs to be refreshed from
   *   its archive URL based on whether the existing source stamp matches the
   *   expected URL and commit hash
   * @throws if the source stamp exists but cannot be read or parsed
   */
  const needsSourceRefresh = async source => {
    await null;
    try {
      const stampText = await fs.readFile(
        `${source.path}/${SOURCE_STAMP_FILE}`,
        'utf-8',
      );
      const stamp = JSON.parse(stampText);
      return (
        stamp.url !== source.url ||
        stamp.commitHash !== source.commitHash ||
        stamp.archiveUrl !== source.archiveUrl
      );
    } catch {
      return true;
    }
  };

  const hasBin = fs.existsSync(bin);
  const hasSource = fs.existsSync(`${moddablePath}/xs/includes/xs.h`);
  const hasRepoGit = fs.existsSync(asset('../../../.git'));
  const hasExplicitOverride = prefix => {
    const source = sourceByPrefix.get(prefix);
    if (!source) return false;
    const urlKey = `${prefix}URL`;
    const hashKey = `${prefix}COMMIT_HASH`;
    const archiveKey = `${prefix}ARCHIVE_URL`;
    const fileUrl = pinnedEnvFromFile[urlKey];
    const fileHash = pinnedEnvFromFile[hashKey];
    const fileArchive =
      pinnedEnvFromFile[archiveKey] ||
      defaultArchiveUrl(source.url, source.commitHash);
    const envUrl = env[urlKey];
    const envHash = env[hashKey];
    const envArchive = env[archiveKey];
    return (
      (typeof envUrl === 'string' &&
        envUrl !== '' &&
        (!hasPinnedEnvFile || envUrl !== fileUrl)) ||
      (typeof envHash === 'string' &&
        envHash !== '' &&
        (!hasPinnedEnvFile || envHash !== fileHash)) ||
      (typeof envArchive === 'string' &&
        envArchive !== '' &&
        (!hasPinnedEnvFile || envArchive !== fileArchive))
    );
  };

  const hasSourceOverride =
    hasExplicitOverride('MODDABLE_') || hasExplicitOverride('XSNAP_NATIVE_');
  const needsPinnedRefresh =
    hasRepoGit &&
    (await Promise.all(sources.map(needsSourceRefresh))).some(needed => needed);
  const shouldFetchSources =
    hasSourceOverride || needsPinnedRefresh || (!hasSource && !hasBin);

  // --show-env reports effective URL/hash pins without making changes.
  if (args.includes('--show-env')) {
    await showEnv(sources, { stdout });
    return;
  }

  // Fetch/update source files via pinned source archives as appropriate.
  if (shouldFetchSources) {
    await updateSources(sources, { fs, curl, tar });
  }

  // If we now have source files, (re)build from them.
  // Otherwise, require presence of a previously-built executable.
  if (hasSource || shouldFetchSources) {
    // Force a rebuild if the binary is missing or reports a version other than
    // this package's — checked against THIS variant's own subtree so a latest
    // build is never fooled by an up-to-date legacy binary (or vice versa).
    let force = !hasBin;
    if (!force) {
      const versionScript = makeCLI(asset('../scripts/get_xsnap_version.sh'), {
        spawn,
      });
      const pjson = await fs.readFile(asset('../package.json'), 'utf-8');
      const expectedVersion = JSON.parse(pjson).version;
      const reportedVersion = await versionScript
        .pipe([variant], { cwd: asset('..') })
        .catch(() => '');
      force = reportedVersion !== expectedVersion;
    }
    await buildXsnap(platform, force, moddablePath, variantPrefix, {
      fs,
      make,
    });
  } else if (!hasBin) {
    throw Error(
      'XSnap has neither sources nor a pre-built binary. Docker? .dockerignore? npm files?',
    );
  }
}

const run = () =>
  main(process.argv.slice(2), {
    env: { ...process.env },
    stdout: process.stdout,
    spawn: childProcessTop.spawn,
    fs: {
      existsSync: fsTop.existsSync,
      readFile: fsTop.promises.readFile,
      writeFile: fsTop.promises.writeFile,
      mkdir: fsTop.promises.mkdir,
      rm: fsTop.promises.rm,
      rename: fsTop.promises.rename,
    },
    os: {
      type: osTop.type,
    },
  });

process.exitCode = 1;
run().then(
  () => {
    process.exitCode = 0;
  },
  err => {
    console.error('Failed with', err);
    process.exit(process.exitCode || 1);
  },
);
