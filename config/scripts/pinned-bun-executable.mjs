import { readFileSync } from 'node:fs'
import path from 'node:path'

export function readPinnedBunVersion(root) {
  return readFileSync(path.join(root, 'config', '.bun-version'), 'utf8').trim()
}

/**
 * Absolute path of the `bun` on PATH when it is exactly the version in config/.bun-version,
 * otherwise null. Another version may target a different TypeScript or runtime contract.
 */
export function resolvePinnedBunExecutable(root, runProcessSync) {
  try {
    const version = readPinnedBunVersion(root)
    const probe = runProcessSync({
      program: 'bun',
      args: [
        '-e',
        'console.log(JSON.stringify({ version: process.versions.bun, executable: process.execPath }))'
      ],
      cwd: root,
      env: process.env,
      timeoutMs: 2000,
      maxOutputBytes: 4096
    })
    if (probe.code !== 0 || probe.signal || probe.timedOut || probe.outputTruncated) {
      return null
    }
    const identity = JSON.parse(probe.stdout)
    return identity.version === version &&
      typeof identity.executable === 'string' &&
      path.isAbsolute(identity.executable)
      ? identity.executable
      : null
  } catch {
    return null
  }
}
