import { execFile, type ChildProcess } from 'node:child_process'
import { closeSync } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { DarwinNetstatListeners } from './darwin-netstat-listeners'
import { openDarwinPortScanLock } from './darwin-port-scan-lock'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS,
  portScanCommandTimeoutMessage,
  type DarwinPortScanOperation
} from './port-scan-command-protocol'

// Why (#11161): libuv runs uv_spawn inline on whichever event loop calls it, so
// an endpoint-security hook on CreateProcessW stalls that thread for the whole
// spawn. This module is only ever entered from the worker thread
// (port-scan-command-worker-entry.ts); nothing on the main thread may import it.

const WATCHDOG_TIMEOUT_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS

const activeChildren = new Set<ChildProcess>()
let stopping = false

/**
 * Run a port-scan probe command and report how long process creation took.
 * @param command - Executable name resolved against the worker's PATH.
 * @param args - Argument vector passed verbatim, never shell-interpolated.
 * @returns The command's stdout plus `spawnMs`, the measured process-creation
 *   latency callers use to skip optional follow-up commands on a stalled host.
 * @throws PortScanCommandTimeoutError when the command itself outran its budget.
 */
export async function runPortScanCommandInProcess(
  command: string,
  args: string[],
  darwinOperation?: DarwinPortScanOperation
): Promise<{ stdout: string; spawnMs: number }> {
  if (stopping) {
    throw new Error('Port scanning is shutting down.')
  }
  if (process.platform === 'darwin' && darwinOperation) {
    return runDarwinPortScanCommand(command, args, darwinOperation)
  }
  return await new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let spawnMs = 0
    let child: ChildProcess | undefined

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (child) {
        activeChildren.delete(child)
      }
      callback()
    }

    const startedAt = Date.now()
    try {
      child = execFile(
        command,
        args,
        {
          timeout: PORT_SCAN_COMMAND_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout) => {
          if (error) {
            // Node kills its own execFile timeout with a signal, which surfaces
            // as killed:true — the only way to tell a timeout from a real error.
            const timedOut = (error as { killed?: boolean }).killed === true
            settle(() =>
              reject(
                timedOut
                  ? new PortScanCommandTimeoutError(
                      portScanCommandTimeoutMessage(command, PORT_SCAN_COMMAND_TIMEOUT_MS)
                    )
                  : error
              )
            )
            return
          }
          settle(() => resolve({ stdout: String(stdout), spawnMs }))
        }
      )
    } catch (error) {
      settle(() => reject(error))
      return
    }

    // Why (#11161): measured after execFile returns, because that call blocks
    // for the whole of process creation. Arming the watchdog earlier would
    // charge the spawn stall against the command's budget and fire immediately.
    spawnMs = Date.now() - startedAt
    if (settled || !child) {
      return
    }
    activeChildren.add(child)
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(
          new PortScanCommandTimeoutError(
            portScanCommandTimeoutMessage(command, WATCHDOG_TIMEOUT_MS)
          )
        )
      })
    }, WATCHDOG_TIMEOUT_MS)
  })
}

function detachChild(child: ChildProcess): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

async function runDarwinPortScanCommand(
  command: string,
  args: string[],
  operation: DarwinPortScanOperation
): Promise<{ stdout: string; spawnMs: number }> {
  const fd = openDarwinPortScanLock(operation)
  let child: ChildProcess
  const startedAt = Date.now()
  try {
    child = spawnProcess({ program: command, args, stdio: [fd, 'pipe', 'pipe'] })
  } finally {
    closeSync(fd)
  }
  const spawnMs = Date.now() - startedAt
  activeChildren.add(child)
  child.once('exit', () => activeChildren.delete(child))
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const listeners = operation === 'listeners' ? new DarwinNetstatListeners() : null
    const settle = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        try {
          child.kill()
        } catch {
          /* Best effort; the child still owns admission. */
        }
        detachChild(child)
        reject(error)
      } else {
        resolve({ stdout, spawnMs })
      }
    }
    const timer = setTimeout(
      () =>
        settle(
          new PortScanCommandTimeoutError(
            portScanCommandTimeoutMessage(command, PORT_SCAN_COMMAND_TIMEOUT_MS)
          )
        ),
      PORT_SCAN_COMMAND_TIMEOUT_MS
    )
    child.once('error', (error) => {
      if (!child.pid) {
        activeChildren.delete(child)
      }
      settle(error)
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) {
        return
      }
      try {
        if (listeners) {
          listeners.write(chunk)
        } else if (stdout.length + chunk.length <= 2 * 1024 * 1024) {
          stdout += chunk
        } else {
          throw new Error('Port scan output is too large.')
        }
      } catch (error) {
        settle(error)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 4096)
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', (error) => settle(error))
    }
    child.once('close', (code, signal) => {
      if (settled) {
        return
      }
      try {
        const emptyLsof = command === '/usr/sbin/lsof' && code === 1 && stdout === ''
        if (signal || stderr || (code !== 0 && !emptyLsof)) {
          throw new Error('Port scan observation is unavailable.')
        }
        if (
          (command === '/usr/sbin/lsof' || command === '/bin/ps') &&
          stdout &&
          !stdout.endsWith('\n')
        ) {
          throw new Error('Incomplete port scan observation.')
        }
        if (listeners) {
          stdout = listeners.finish()
        }
        settle()
      } catch (error) {
        settle(error)
      }
    })
  })
}

/** Signal owned children and detach without waiting for an uninterruptible acquisition. */
export function killActivePortScanCommands(): void {
  stopping = true
  for (const child of activeChildren) {
    try {
      child.kill()
    } catch {
      // Already exited; nothing to reap.
    }
    if (process.platform === 'darwin') {
      detachChild(child)
    }
  }
  if (process.platform !== 'darwin') {
    activeChildren.clear()
  }
}
