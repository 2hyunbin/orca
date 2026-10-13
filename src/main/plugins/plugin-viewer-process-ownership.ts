import { app, webContents } from 'electron'

export type PluginViewerProcessOwner = {
  id: number
  valid: boolean
  frames: readonly { frameId: number; processId: number; pid: number }[]
}
export type PluginViewerProcessMetric = {
  pid: number
  creationTime: number
  type: string
  residentBytes: number
  cpuSeconds: number | undefined
}

export function capturePluginViewerProcessOwners(): PluginViewerProcessOwner[] {
  return webContents.getAllWebContents().flatMap((contents) => {
    if (contents.isDestroyed()) {
      return []
    }
    try {
      let valid = true
      const frames = contents.mainFrame.framesInSubtree.flatMap((frame) => {
        const owner = webContents.fromFrame(frame)
        if (!owner) {
          valid = false
        }
        // Embedded guests also appear in the ancestor's subtree.
        return owner && owner.id !== contents.id
          ? []
          : [{ frameId: frame.frameTreeNodeId, processId: frame.processId, pid: frame.osProcessId }]
      })
      return [{ id: contents.id, valid: valid && frames.length > 0, frames }]
    } catch {
      return [
        {
          id: contents.id,
          valid: false,
          frames: [{ frameId: 0, processId: 0, pid: contents.getOSProcessId() }]
        }
      ]
    }
  })
}

export function capturePluginViewerProcessMetrics(): PluginViewerProcessMetric[] {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    creationTime: metric.creationTime,
    type: metric.type,
    residentBytes: metric.memory.workingSetSize * 1024,
    cpuSeconds: metric.cpu.cumulativeCPUUsage
  }))
}

export function exclusivePluginViewerFrames(
  id: number,
  owners: readonly PluginViewerProcessOwner[],
  requireKnownPeers = false
): PluginViewerProcessOwner['frames'] | null {
  const own = owners.find((owner) => owner.id === id)
  if (
    (requireKnownPeers &&
      owners.some((owner) => !owner.valid && owner.frames.some((frame) => frame.pid > 0))) ||
    !own?.valid ||
    !own.frames.length ||
    own.frames.some(
      (frame) =>
        !Number.isSafeInteger(frame.pid) ||
        frame.pid <= 0 ||
        !Number.isSafeInteger(frame.frameId) ||
        frame.frameId < 0 ||
        !Number.isSafeInteger(frame.processId) ||
        frame.processId <= 0
    ) ||
    new Set(own.frames.map((frame) => frame.frameId)).size !== own.frames.length
  ) {
    return null
  }
  const pids = new Set(own.frames.map((frame) => frame.pid))
  if (
    owners.some((owner) => owner.id !== id && owner.frames.some((frame) => pids.has(frame.pid)))
  ) {
    return null
  }
  return own.frames
}

export function pluginViewerFrameIdentity(frames: PluginViewerProcessOwner['frames']): string {
  return JSON.stringify(
    frames.map((frame) => [frame.frameId, frame.processId, frame.pid]).sort((a, b) => a[0] - b[0])
  )
}
