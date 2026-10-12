import { win32 } from 'node:path'
import { runWslProcess, type WslResult, type WslSpec } from '../wsl/wsl-runner'
import { translateArgForWsl } from './command-runner/wsl-path-translation'

/**
 * Per-command config that makes Linux Git read a Windows Git checkout the way Windows Git does.
 *
 * - core.autocrlf=true: compare CRLF working files against LF blobs as equal, and stage LF —
 *   without it every rehashed file reads as modified and `add` commits CRLF.
 * - core.checkStat=minimal / core.trustctime=false: an index Windows Git wrote carries no inode
 *   or ctime Linux Git agrees with, so every entry otherwise rehashes across drvfs.
 *
 * All three predate the Git 2.25 baseline, so no capability probe is needed.
 */
export const WINDOWS_CHECKOUT_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.autocrlf=true',
  '-c',
  'core.checkStat=minimal',
  '-c',
  'core.trustctime=false'
]

// Top-level tracked files only: enough to see the checkout's line endings without walking the tree.
const PROBE_GIT_ARGS = ['ls-files', '--eol', '--', ':(top,glob)*']
const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024
// Why a TTL at all: a re-clone at the same path can change the answer; one cheap probe per window.
export const WSL_WINDOWS_CHECKOUT_RESULT_TTL_MS = 10 * 60_000
const RETRY_BASE_MS = 30_000
const CACHE_LIMIT = 256

type CachedResult = { matchesWindowsCheckout: boolean; expiresAt: number }
type Failure = { count: number; retryAfter: number }

const results = new Map<string, CachedResult>()
const pending = new Map<string, Promise<void>>()
const failures = new Map<string, Failure>()

export type WslWindowsCheckoutProbeRunner = (spec: WslSpec) => Promise<WslResult>

export type WslWindowsCheckoutOptions = {
  platform?: NodeJS.Platform
  now?: () => number
  run?: WslWindowsCheckoutProbeRunner
}

function isCandidate(
  cwd: string | undefined,
  wslDistro: string | undefined,
  platform: NodeJS.Platform
): cwd is string {
  return platform === 'win32' && Boolean(wslDistro) && Boolean(cwd && /^[A-Za-z]:[/\\]/.test(cwd))
}

function cacheKey(cwd: string, wslDistro: string): string {
  return `${wslDistro.toLowerCase()}\0${win32.resolve(cwd).toLowerCase()}`
}

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  if (map.size >= CACHE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) {
      map.delete(oldest)
    }
  }
  map.set(key, value)
}

/**
 * True when most top-level text files are LF in the index but CRLF on disk with no
 * `.gitattributes` eol rule — the shape Windows Git's autocrlf leaves behind.
 *
 * Why a majority: one CRLF file saved by a Windows editor into an LF checkout must not flip
 * Orca's checkouts in that repo to CRLF.
 */
export function looksLikeWindowsAutocrlfCheckout(lsFilesEolOutput: string): boolean {
  let crlf = 0
  let lf = 0
  for (const line of lsFilesEolOutput.split('\n')) {
    const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/([^\t]*)\t/.exec(line)
    if (!match || match[1] !== 'lf' || match[3].trim() !== '') {
      continue
    }
    if (match[2] === 'crlf') {
      crlf += 1
    } else if (match[2] === 'lf') {
      lf += 1
    }
  }
  return crlf > 0 && crlf > lf
}

async function probe(
  key: string,
  cwd: string,
  wslDistro: string,
  run: WslWindowsCheckoutProbeRunner,
  now: () => number
): Promise<void> {
  let result: WslResult | null = null
  try {
    result = await run({
      distro: wslDistro,
      program: 'git',
      args: ['-C', translateArgForWsl(cwd), ...PROBE_GIT_ARGS],
      loginPath: 'preferred',
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })
  } catch {
    result = null
  }
  // 128 is Git's "not a repository": a settled answer (e.g. a folder workspace), not a failure.
  if (result && !result.timedOut && (result.code === 0 || result.code === 128)) {
    const matchesWindowsCheckout =
      result.code === 0 && looksLikeWindowsAutocrlfCheckout(result.stdout)
    if (matchesWindowsCheckout && !results.get(key)?.matchesWindowsCheckout) {
      console.info(
        `[git] ${cwd}: Windows line-ending checkout detected; WSL git runs with core.autocrlf=true`
      )
    }
    failures.delete(key)
    setBounded(results, key, {
      matchesWindowsCheckout,
      expiresAt: now() + WSL_WINDOWS_CHECKOUT_RESULT_TTL_MS
    })
    return
  }
  const count = (failures.get(key)?.count ?? 0) + 1
  const delay = Math.min(RETRY_BASE_MS * 2 ** (count - 1), WSL_WINDOWS_CHECKOUT_RESULT_TTL_MS)
  setBounded(failures, key, { count, retryAfter: now() + delay })
}

function startProbe(
  key: string,
  cwd: string,
  wslDistro: string,
  options: WslWindowsCheckoutOptions
): Promise<void> {
  const running = pending.get(key)
  if (running) {
    return running
  }
  const started = probe(
    key,
    cwd,
    wslDistro,
    options.run ?? runWslProcess,
    options.now ?? Date.now
  ).finally(() => pending.delete(key))
  pending.set(key, started)
  return started
}

function waitUnlessAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return work
  }
  // Why: an aborted command stops waiting, but the shared probe keeps running for the next caller.
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', done, { once: true })
    void work.then(done)
  })
}

/**
 * The probe a WSL git command on a Windows drive must wait for, or null when there is nothing to
 * wait for. Never rejects.
 *
 * Only the first command for a checkout waits; an expired answer keeps serving while a refresh
 * runs in the background, so polling never sits behind the probe.
 */
export function pendingWslWindowsCheckoutProbe(
  cwd: string | undefined,
  wslDistro: string | undefined,
  signal?: AbortSignal,
  options: WslWindowsCheckoutOptions = {}
): Promise<void> | null {
  const platform = options.platform ?? process.platform
  if (!isCandidate(cwd, wslDistro, platform) || !wslDistro) {
    return null
  }
  const now = (options.now ?? Date.now)()
  const key = cacheKey(cwd, wslDistro)
  const cached = results.get(key)
  if (cached && cached.expiresAt > now) {
    return null
  }
  const failure = failures.get(key)
  if (failure && failure.retryAfter > now) {
    return null
  }
  const work = startProbe(key, cwd, wslDistro, options)
  return cached ? null : waitUnlessAborted(work, signal)
}

/** `args` with the Windows-checkout config prepended when this WSL checkout was written by Windows Git. */
export function withWslWindowsCheckoutGitConfig(
  args: string[],
  cwd: string | undefined,
  wslDistro: string | undefined,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!isCandidate(cwd, wslDistro, platform) || !wslDistro) {
    return args
  }
  return results.get(cacheKey(cwd, wslDistro))?.matchesWindowsCheckout
    ? [...WINDOWS_CHECKOUT_GIT_CONFIG_ARGS, ...args]
    : args
}

export function resetWslWindowsCheckoutGitConfigForTests(): void {
  results.clear()
  pending.clear()
  failures.clear()
}
