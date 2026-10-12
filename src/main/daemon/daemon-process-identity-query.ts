import { runProcess, runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

const PS_IDENTITY_TIMEOUT_MS = 2_000

export type PsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

function psIdentityArgs(pid: number): string[] {
  return ['-p', String(pid), '-o', 'lstart=', '-o', 'command=']
}

function parsePsProcessIdentity(result: ProcessResult, utc = false): PsProcessIdentity | null {
  // ps exits non-zero for a missing pid; a timeout is not evidence either way.
  if (result.code !== 0 || result.timedOut) {
    return null
  }
  // BSD ps formats lstart as a fixed-width 24-character timestamp.
  const startedAtMs = Date.parse(result.stdout.slice(0, 24) + (utc ? ' UTC' : ''))
  return {
    commandLine: result.stdout.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  }
}

export function getPsProcessIdentity(
  pid: number,
  options?: { utc?: boolean }
): PsProcessIdentity | null {
  try {
    const result = runProcessSync({
      program: 'ps',
      args: psIdentityArgs(pid),
      timeoutMs: PS_IDENTITY_TIMEOUT_MS,
      ...(options?.utc ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } } : {})
    })
    return parsePsProcessIdentity(result, options?.utc)
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<PsProcessIdentity | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: psIdentityArgs(pid),
      timeoutMs: PS_IDENTITY_TIMEOUT_MS
    })
    return parsePsProcessIdentity(result)
  } catch {
    return null
  }
}
