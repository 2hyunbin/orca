import { runProcess } from '@orca/process-host'

/** File handles are evidence only; this probe never closes handles or stops their owners. */
export async function captureDirectoryHandles(root: string, phase: string): Promise<unknown> {
  if (!phase.endsWith('Failed') || process.platform !== 'win32' || !process.env.CI) {
    return undefined
  }
  const program = process.env.ORCA_SERVE_CLEANUP_HANDLE_EXE
  if (!program) {
    return { unavailable: 'Handle was not prepared' }
  }
  try {
    const result = await runProcess({
      program,
      args: ['-accepteula', '-nobanner', root],
      // Fit inside the existing 60s hook after removal retries.
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
      killOnOutputLimit: true
    })
    return {
      code: result.code,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.name : 'unknown error' }
  }
}
