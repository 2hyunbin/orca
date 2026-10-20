import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isNodeRuntimeTarget,
  type NodeRuntimeTarget,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import { ORCAD_SERVER_TARGET_FILENAME } from '../../shared/orcad-artifacts'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import { execCommand } from './remote-exec/remote-exec-command'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/** The host answered the libc probe, but with nothing this client recognises. */
export class UnidentifiedHostLibcError extends Error {
  constructor() {
    super('Could not identify the host C library for the bundled Orca runtime')
    this.name = 'UnidentifiedHostLibcError'
  }
}

export function parseOrcadLinuxLibc(output: string): 'glibc' | 'musl' {
  if (/\bmusl\b/i.test(output)) {
    return 'musl'
  }
  if (/\b(?:glibc|GNU libc|GNU C Library)\b/i.test(output)) {
    return 'glibc'
  }
  throw new UnidentifiedHostLibcError()
}

export type GlibcVersion = { major: number; minor: number }

export type OrcadDeploymentTargetFacts = {
  target: ServerTarget
  /** The host's glibc, when the libc probe printed one; null on musl and non-Linux hosts. */
  glibc: GlibcVersion | null
}

/** Reads ldd, getconf and the GNU loader's release banner. */
export function parseGlibcVersion(output: string): GlibcVersion | null {
  const firstLine = output.split('\n', 1)[0] ?? ''
  const match =
    /(\d+)\.(\d+)\s*$/.exec(firstLine.trim()) ??
    /\bglibc\s+(\d+)\.(\d+)/i.exec(output) ??
    /\bGNU libc\b[^\n]*\brelease version (\d+)\.(\d+)/i.exec(firstLine)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export async function resolveOrcadDeploymentTargetFacts(options: {
  conn: RemoteInstallTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<OrcadDeploymentTargetFacts> {
  const { host } = options
  if (host.os !== 'linux') {
    return { target: `${host.os}-${host.arch}`, glibc: null }
  }
  const exec =
    options.exec ??
    ((command: string) => execCommand(options.conn, command, { signal: options.signal }))
  const probes = [
    'ldd --version 2>&1 || true',
    'getconf GNU_LIBC_VERSION 2>/dev/null || ' +
      'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
    // DSM ships the GNU loader without ldd or getconf.
    'for loader in /lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1; do ' +
      '[ ! -x "$loader" ] || { "$loader" --version 2>/dev/null && break; }; done || true'
  ]
  for (const probe of probes) {
    const output = await exec(probe)
    try {
      return linuxTargetFacts(host, output)
    } catch (error) {
      if (!(error instanceof UnidentifiedHostLibcError)) {
        throw error
      }
    }
  }
  throw new UnidentifiedHostLibcError()
}

function linuxTargetFacts(host: RemoteHostPlatform, output: string): OrcadDeploymentTargetFacts {
  const libc = parseOrcadLinuxLibc(output)
  return {
    target: `linux-${host.arch}-${libc}`,
    glibc: libc === 'glibc' ? parseGlibcVersion(output) : null
  }
}

/** The runtime target an assembled bundle was built for, a compat one included. */
export function readOrcadBundleTarget(localOrcadDir: string): NodeRuntimeTarget {
  const recorded = readFileSync(join(localOrcadDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8').trim()
  if (!isNodeRuntimeTarget(recorded)) {
    throw new Error(`The orcad bundle names no known server target: ${recorded}`)
  }
  return recorded
}
