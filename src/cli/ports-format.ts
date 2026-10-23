import type { WorkspacePort, WorkspacePortHostScanResult } from '../shared/workspace-ports'

function formatPortOwner(port: WorkspacePort): string {
  if (port.kind === 'workspace') {
    return `workspace=${port.owner.displayName || port.owner.worktreeId}`
  }
  return port.kind === 'container' ? 'workspace=(container)' : 'workspace=(none)'
}

function formatPortRow(port: WorkspacePort, showOwner: boolean): string {
  return [
    String(port.port),
    ...(showOwner ? [formatPortOwner(port)] : []),
    `pid=${port.pid ?? '?'}`,
    port.processName ?? '(unknown process)',
    port.connectHost,
    port.protocol,
    ...(port.kind === 'workspace' ? [`match=${port.owner.confidence}`] : []),
    ...(port.kind === 'workspace' && port.advertisedUrl ? [`url=${port.advertisedUrl}`] : [])
  ].join('  ')
}

export function formatPortsScan(
  scan: WorkspacePortHostScanResult,
  options: { showOwner: boolean }
): string {
  const host = `host=${scan.executionHostId}`
  if (scan.unavailableReason) {
    return `Port scan unavailable: ${scan.unavailableReason}\n${host}`
  }
  if (scan.ports.length === 0) {
    return `No listening ports found.\n${host}`
  }
  const rows = scan.ports.map((port) => formatPortRow(port, options.showOwner))
  return `${rows.join('\n')}\n\n${host}`
}
