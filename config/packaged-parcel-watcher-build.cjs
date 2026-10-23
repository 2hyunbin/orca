const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const {
  macBinaryArchProblem,
  requiresParcelWatcherSourceBuild
} = require('./scripts/native-build-entry.cjs')

/**
 * Ship exactly the patched watcher.node for this slice, after adoptPackagedNativeBuildEntries.
 *
 * Why fail packaging: the patched loader falls back to the upstream prebuild (fixed 1 ms FSEvents
 * latency) without a word, so a missing or wrong-arch build would only show up as fseventsd load.
 */
function finalizePackagedParcelWatcherBuild(
  resourcesDir,
  electronPlatformName,
  architecture,
  archProblem = macBinaryArchProblem
) {
  const packageDir = join(resourcesDir, 'node_modules', '@parcel', 'watcher')
  if (!existsSync(packageDir)) {
    return
  }
  const buildDir = join(packageDir, 'build')
  if (!requiresParcelWatcherSourceBuild(electronPlatformName)) {
    rmSync(buildDir, { recursive: true, force: true })
    return
  }
  const addon = join(buildDir, 'Release', 'watcher.node')
  if (!existsSync(addon)) {
    throw new Error(
      `Packaging ${electronPlatformName}/${architecture} has no patched @parcel/watcher build at ${addon}. ` +
        'Run pnpm run rebuild:electron (the beforeBuild hook normally produces it).'
    )
  }
  const problem = archProblem(addon, architecture)
  if (problem) {
    throw new Error(`Packaging ${electronPlatformName}/${architecture}: ${problem}`)
  }
  // An in-place node-gyp build leaves objects, makefiles and config beside the addon.
  for (const name of readdirSync(buildDir)) {
    if (name !== 'Release') {
      rmSync(join(buildDir, name), { recursive: true, force: true })
    }
  }
  for (const name of readdirSync(join(buildDir, 'Release'))) {
    if (name !== 'watcher.node') {
      rmSync(join(buildDir, 'Release', name), { recursive: true, force: true })
    }
  }
}

module.exports = { finalizePackagedParcelWatcherBuild }
