import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

import { extractLastOsc7Uri, extractOscScanTail } from '../../../daemon/osc7-uri-extraction'
import { parseFileUriPathParts } from '../../../daemon/osc7-file-uri'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function extractLastOsc7CwdForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string
): { path: string; hostname: string } | null {
  const previousTail = output.osc7ScanTailByPtyId.get(ptyId)
  if (!previousTail && !data.includes('\x1b]7;')) {
    return null
  }
  const input = `${previousTail ?? ''}${data}`
  const scanTail = extractOscScanTail(input, 4096)
  if (scanTail.length > 0) {
    output.osc7ScanTailByPtyId.set(ptyId, scanTail)
  } else {
    output.osc7ScanTailByPtyId.delete(ptyId)
  }
  const uri = extractLastOsc7Uri(input)
  const pty = output.host.ptysById.get(ptyId)
  const pathFlavor = output.host.pathFlavorForPty(pty)
  return uri
    ? parseFileUriPathParts(uri, {
        pathFlavor,
        remotePosixAuthority: !!pty?.connectionId && pathFlavor !== 'win32',
        wslDistro: pty?.connectionId
          ? undefined
          : (output.host.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
      })
    : null
}

export function recordOsc7MetadataForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string
): { cwd: string | null; cwdChanged: boolean } {
  const osc7 = output.host.extractLastOsc7CwdForPty(ptyId, data)
  const cwd = osc7?.path ?? null
  const cwdChanged =
    cwd !== null && cwd.trim().length > 0 && output.terminalCwdByPtyId.get(ptyId) !== cwd
  if (cwdChanged) {
    output.terminalCwdByPtyId.set(ptyId, cwd)
  }
  if (osc7) {
    if (osc7.hostname) {
      output.terminalFileUriHostnameByPtyId.set(ptyId, osc7.hostname)
    } else {
      output.terminalFileUriHostnameByPtyId.delete(ptyId)
    }
  }
  return { cwd, cwdChanged }
}

export function pathFlavorForPty(pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' {
  if (!pty?.connectionId) {
    return process.platform === 'win32' ? 'win32' : 'posix'
  }
  const worktreePath = splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath
  return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'posix'
}
