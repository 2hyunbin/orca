// A test hook on main's layout records frames: tests install main's model check here, so every
// frame is checked against a fresh projection. Dev builds log the check; release builds run none.

import { logLayoutFrameModelErrors } from './workspace-layout-frame-model-check'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutRecordsFrame } from '../../shared/workspace-layout/workspace-layout-stream-frames'

export type LayoutFrameObservation = {
  frame: WorkspaceLayoutRecordsFrame
  /** What subscribers held before the frame. */
  before: ReadonlyMap<string, PublishedWorkspaceLayout>
  /** Every workspace as a projection from scratch publishes it now. */
  fresh: () => ReadonlyMap<string, PublishedWorkspaceLayout>
}

export type LayoutFrameObserver = (observation: LayoutFrameObservation) => void

let observer: LayoutFrameObserver | null = null

// Why NODE_ENV: electron-vite sets it to 'development' only for a dev build; tests set 'test'.
const DEV_BUILD_CHECK: LayoutFrameObserver | null =
  process.env.NODE_ENV === 'development' ? logLayoutFrameModelErrors : null

/** Null removes the observer. */
export function observeWorkspaceLayoutFrames(next: LayoutFrameObserver | null): void {
  observer = next
}

export function workspaceLayoutFrameObserver(): LayoutFrameObserver | null {
  return observer ?? DEV_BUILD_CHECK
}
