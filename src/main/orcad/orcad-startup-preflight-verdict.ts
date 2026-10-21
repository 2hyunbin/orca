/**
 * A managed slot's passed startup preflight, so its disposable second Node process runs once per
 * install instead of on every start (MEASURED 0.4–1.0 s per orcad start on WSL hosts). The verdict
 * is bound to a stat fingerprint of everything the preflight qualified: the installed artifacts, the
 * Node runtime, and on Linux the shared-library cache the native modules load through.
 */
import { createHash, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME
} from '../../shared/orcad-artifacts'
import { listOrcadArtifactFiles } from './orcad-artifact-identity'
import { resolveBundledOrcadSlot } from './orcad-bundled-runtime'

export const ORCAD_STARTUP_PREFLIGHT_VERDICT_FILENAME = '.orcad-startup-preflight.json'
// Bump whenever the preflight or the fingerprint gains a check, so old verdicts stop matching.
const VERDICT_FORMAT = 1
const LINUX_LIBRARY_CACHE = '/etc/ld.so.cache'

const verdictSchema = z.object({
  format: z.literal(VERDICT_FORMAT),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  artifactVersion: z.string().min(1),
  runtimeVersion: z.string().min(1)
})
export type OrcadStartupPreflightVerdict = z.infer<typeof verdictSchema>

/** Only a client-managed slot (SSH or WSL); a packaged app directory keeps preflighting every start. */
export function startupPreflightVerdictPath(
  slotDirectory: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
    ? join(slotDirectory, ORCAD_STARTUP_PREFLIGHT_VERDICT_FILENAME)
    : null
}

async function statPart(label: string, path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${label}:${s.size}:${s.mtimeMs}:${s.ino}:${s.dev}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return `${label}:absent`
    }
    throw error
  }
}

/** Null when any input is unreadable: never skip a preflight on a partial fingerprint. */
export async function computeStartupPreflightFingerprint(
  slotDirectory: string,
  runtime: { execPath: string; nodeVersion: string; platform: NodeJS.Platform; arch: string } = {
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }
): Promise<string | null> {
  try {
    const files = new Set([
      ...(await listOrcadArtifactFiles(slotDirectory)),
      ORCAD_VERSION_FILENAME,
      ORCAD_SERVER_TARGET_FILENAME,
      ORCAD_MOBILE_WEB_MANIFEST
    ])
    const parts = [`format:${VERDICT_FORMAT}`]
    for (const file of [...files].sort()) {
      const part = await statPart(file, join(slotDirectory, file))
      if (part.endsWith(':absent')) {
        return null
      }
      parts.push(part)
    }
    parts.push(await statPart(`node:${runtime.execPath}`, runtime.execPath))
    parts.push(`runtime:${runtime.nodeVersion}:${runtime.platform}:${runtime.arch}`)
    if (runtime.platform === 'linux') {
      // Any library install or upgrade rewrites this cache; the native modules dlopen through it.
      parts.push(await statPart('ld.so.cache', LINUX_LIBRARY_CACHE))
      parts.push(`kernel:${release()}`)
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex')
  } catch {
    return null
  }
}

export async function readStartupPreflightVerdict(
  path: string
): Promise<OrcadStartupPreflightVerdict | null> {
  try {
    return verdictSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

/** Atomic, so a concurrent start never reads half a verdict; best effort by design. */
export async function writeStartupPreflightVerdict(
  path: string,
  verdict: Omit<OrcadStartupPreflightVerdict, 'format'>
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ format: VERDICT_FORMAT, ...verdict }), {
      mode: 0o600
    })
    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => {})
  }
}

export async function forgetStartupPreflightVerdict(path: string | null): Promise<void> {
  if (path) {
    await unlink(path).catch(() => {})
    await unlink(path + PENDING_SUFFIX).catch(() => {})
  }
}

/** For the exit path: a start that failed after a skipped preflight must preflight next time. */
export function forgetStartupPreflightVerdictSync(path: string | null): void {
  if (!path) {
    return
  }
  for (const file of [path, path + PENDING_SUFFIX]) {
    try {
      unlinkSync(file)
    } catch {
      // Absent or unwritable: the next start compares the fingerprint anyway.
    }
  }
}

/** The running slot's verdict, for exit paths that have no slot directory in hand. */
export function forgetSlotStartupPreflightVerdict(
  resolveSlot: () => string = () => resolveBundledOrcadSlot()
): void {
  try {
    forgetStartupPreflightVerdictSync(startupPreflightVerdictPath(resolveSlot()))
  } catch {
    // An unresolvable slot never wrote a verdict.
  }
}

const PENDING_SUFFIX = '.pending'

/**
 * Claims a skip for this start. A start that dies before readiness (a crash, a signal) never runs
 * the failure path, so its marker survives and the next start probes instead of skipping again.
 */
export async function claimStartupPreflightSkip(path: string): Promise<boolean> {
  try {
    await stat(path + PENDING_SUFFIX)
    return false
  } catch {
    // No unfinished skipped start: claim this one.
  }
  try {
    await writeFile(path + PENDING_SUFFIX, `${process.pid}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Readiness published: the skipped preflight's verdict held for this start. */
export function settleSlotStartupPreflightSkip(
  resolveSlot: () => string = () => resolveBundledOrcadSlot()
): void {
  try {
    const path = startupPreflightVerdictPath(resolveSlot())
    if (path) {
      unlinkSync(path + PENDING_SUFFIX)
    }
  } catch {
    // No skip was claimed, or the slot is unresolvable.
  }
}
