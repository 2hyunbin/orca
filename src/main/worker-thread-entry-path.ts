import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/** Keep this reachable from plain-Node entries; the build guard rejects Electron imports here. */
export type WorkerEntryLayout = {
  isPackaged: boolean
  /** Undefined on a non-Electron host: `process.resourcesPath` is Electron-only. */
  resourcesPath: string | undefined
  moduleDir: string
}

export function resolveWorkerThreadEntryPath(
  layout: WorkerEntryLayout,
  entryFileName: string
): string {
  // Plain-Node orcad can be packaged without Electron resources; its workers live beside the module.
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'app.asar', 'out', 'main', entryFileName)
  }
  return join(layout.moduleDir, entryFileName)
}

export function currentWorkerEntryLayout(moduleDir: string): WorkerEntryLayout {
  return {
    isPackaged: hasAppEnvironment() && getAppEnvironment().isPackaged(),
    resourcesPath:
      'resourcesPath' in process && typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined,
    moduleDir
  }
}
